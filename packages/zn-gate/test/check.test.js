'use strict';

// zn-gate check: an agent counts as protected only when its zn hook for reading
// files is installed, zn blocks the fake .env and allows an ordinary file, and
// the installed hook does the same when it is run as the agent runs it.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { check: realCheck, report } = require('../lib/check');
// These tests are about what they say whatever Node.js runs them: the plugin needs 20.19 or later, so one that
// supports it is injected (the check for older versions is in init_plugin_node.test.js).
const check = (opts) => realCheck({ nodeVersion: '22.0.0', ...opts });
const { tempDir } = require('./helpers/tmp');
const { pluginHooks, writePluginManifest } = require('./helpers/claude_plugin');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

function homeWithHooks(t, agents) {
  const home = tempDir(t, 'zn-check-home-');
  const env = { HOME: home, PATH: process.env.PATH };
  for (const id of agents) {
    getAdapter(id).install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  }
  return { home, env, cwd: tempDir(t, 'zn-check-cwd-') };
}

function textOf(res) {
  let s = '';
  const code = report(res, (x) => { s += x; });
  return { s, code };
}

const byId = (res, id) => res.results.find((r) => r.id === id);

// A plugin installed where Claude Code installs plugins (or at `root`), listed in installed_plugins.json. `manifest`:
// the hooks.json to write (a valid one by default), or null for none.
function fakePlugin(home, launcherSource, settings, { manifest = pluginHooks(), root } = {}) {
  root = root || path.join(home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate', '1.8.1');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'zn-launch.js'), launcherSource);
  fs.rmSync(path.join(root, 'hooks'), { recursive: true, force: true });
  if (manifest) writePluginManifest(root, manifest);
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'zn-gate@usezn': [{ scope: 'user', installPath: root }] } }));
  if (settings) fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  return root;
}

// A stand-in for the plugin launcher that hands the event to the real runner (as the real launcher does after
// verifying the pinned package), or fails closed on every event when `broken`.
function launcher({ broken = false, systemMessage = '', marker = '' } = {}) {
  return (marker ? "require('fs').appendFileSync(" + JSON.stringify(marker) + ", 'ran\\n');\n" : '') +
    "const [mode] = process.argv.slice(2);\n" +
    "if (mode === 'check') { " + (systemMessage ? "process.stdout.write(JSON.stringify({ systemMessage: " + JSON.stringify(systemMessage) + " }));" : '') + " process.exit(0); }\n" +
    (broken ? "process.stderr.write('zn plugin: zn-gate is not installed'); process.exit(2);\n"
      : "const r = require('child_process').spawnSync(process.execPath, [" + JSON.stringify(RUNNER) + ", 'claude-code'], { input: require('fs').readFileSync(0), encoding: 'utf8' });\n" +
        "process.stdout.write(r.stdout || ''); process.exit(r.status || 0);\n");
}

test('check: every agent installed for the user blocks .env and allows an ordinary file, also through the installed hook', async (t) => {
  const ctx = homeWithHooks(t, ['claude-code', 'codex', 'cursor', 'opencode', 'antigravity', 'gemini', 'copilot', 'zcode']);
  const res = await check(ctx);
  for (const r of res.results) {
    assert.equal(r.state, 'protected', `${r.id}: ${r.problem}`);
    assert.ok(r.message.length > 0, r.id);
    if (r.id !== 'opencode') assert.equal(r.verified, true, `${r.id}: installed hook not run`);
  }
  assert.equal(res.removed, true);
  const { s, code } = textOf(res);
  assert.equal(code, 0);
  assert.match(s, /OK Claude Code\s+blocked the \.env file and allowed the ordinary file/);
  assert.match(s, /its plugin runs inside OpenCode, so it was not started here/);
  assert.match(s, /zn env shadow \.env/);
});

/* A PATH with only a stand-in `zn` (or nothing), so what is found does not depend on the machine running the tests. */
function binDir(t, withZn) {
  const bin = tempDir(t, 'zn-check-bin-');
  if (withZn) for (const f of ['zn', 'zn.cmd']) fs.writeFileSync(path.join(bin, f), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return bin;
}

test('check: no setup at all is a failure, with the command for each agent found', async (t) => {
  const home = tempDir(t, 'zn-check-empty-');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.codex'));
  const res = await check({ home, env: { HOME: home, PATH: binDir(t, true) }, cwd: home });
  const { s, code } = textOf(res);
  assert.equal(code, 1);
  assert.match(s, /Codex CLI\s+zn is not set up for this agent\. To protect it, run `zn hooks install codex` in your own terminal/);
  assert.match(s, /claude plugin install zn-gate@usezn/);
  assert.match(s, /Cursor\s+not found on this machine\n/);
  assert.match(s, /To set it up, run `npx -y zn-gate init` in your own terminal/);
});

test('check: without a `zn` command (npx only), the setup starts with a global install', async (t) => {
  const home = tempDir(t, 'zn-check-npx-');
  fs.mkdirSync(path.join(home, '.codex'));
  const res = await check({ home, env: { HOME: home, PATH: binDir(t, false) }, cwd: home });
  assert.equal(byId(res, 'codex').fix, 'run `npm install -g zn-gate`, then `zn hooks install codex`, in your own terminal');
  const { s } = textOf(res);
  assert.match(s, /Claude Code\s+not found on this machine\n/);
});

test('check: no agent on the machine says so and offers no setup', async (t) => {
  const home = tempDir(t, 'zn-check-none-');
  const res = await check({ home, env: { HOME: home, PATH: binDir(t, false) }, cwd: home });
  const { s, code } = textOf(res);
  assert.equal(code, 1);
  assert.match(s, /No supported coding agent was found on this machine/);
  assert.match(s, /Install one, then run `npx -y zn-gate init`/);
  assert.doesNotMatch(s, /zn hooks install|plugin install/);
});

test('check: an agent found but not set up is named after the protected ones, with the same exit code', async (t) => {
  const ctx = homeWithHooks(t, ['codex']);
  fs.mkdirSync(path.join(ctx.home, '.claude'), { recursive: true });
  const res = await check({ ...ctx, env: { ...ctx.env, PATH: binDir(t, true) } });
  const { s, code } = textOf(res);
  assert.equal(code, 0);
  assert.match(s, /Not set up yet: Claude Code\. To add it, run `npx -y zn-gate init`/);
});

// A hook written by an older zn-gate: the plain command with the absolute Node.js and runner paths, no launcher.
function legacyCodexHome(t) {
  const ctx = homeWithHooks(t, []);
  const command = require('../lib/agents/config-file').hookCommand('codex', { nodePath: process.execPath, runnerPath: RUNNER });
  getAdapter('codex').install({ scope: 'user', home: ctx.home, env: ctx.env, command, mcp: false });
  return ctx;
}

test('check: a hook whose Node.js is gone is not protected', async (t) => {
  const ctx = legacyCodexHome(t);
  const file = getAdapter('codex').hooksFile(ctx);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(process.execPath.replace(/\\/g, '/')).join(path.join(ctx.home, 'gone', 'node').replace(/\\/g, '/')));
  const r = byId(await check(ctx), 'codex');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /Node\.js .* is no longer there/);
  // The repair names a fresh global install first: the old Node.js took its `zn` with it.
  assert.equal(r.fix, 'install zn-gate again for the Node.js you use now: run `npm install -g zn-gate`, then `zn hooks install codex`, in your own terminal');
});

test('check: Claude Code set up with zn hooks is repaired with zn hooks, not with the plugin', async (t) => {
  // A hook written by an older zn-gate: the plain command with the absolute Node.js and runner paths, no launcher.
  const ctx = homeWithHooks(t, []);
  const command = require('../lib/agents/claude-code').hookCommand({ nodePath: process.execPath, runnerPath: RUNNER });
  getAdapter('claude-code').install({ scope: 'user', home: ctx.home, env: ctx.env, command, mcp: false });
  const file = getAdapter('claude-code').settingsFile(ctx);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(process.execPath.replace(/\\/g, '/')).join(path.join(ctx.home, 'gone', 'node').replace(/\\/g, '/')));
  const r = byId(await check(ctx), 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.match(r.fix, /`zn hooks install claude-code`/);
  assert.doesNotMatch(r.fix, /plugin/);
  const { s } = textOf(await check(ctx));
  assert.match(s, /To fix it, install zn-gate again for the Node\.js you use now: run `npm install -g zn-gate`, then `zn hooks install claude-code`/);
});

test('check: a Claude Code prompt hook without onFailure "block" gets a note', async (t) => {
  const ctx = homeWithHooks(t, ['claude-code']);
  const file = getAdapter('claude-code').settingsFile(ctx);
  const ok = byId(await check(ctx), 'claude-code');
  assert.equal(ok.state, 'protected');
  assert.ok(!ok.notes.some((n) => /prompt hook/.test(n)));
  const tree = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const g of tree.hooks.UserPromptSubmit) for (const h of g.hooks || []) delete h.onFailure;
  fs.writeFileSync(file, JSON.stringify(tree));
  const r = byId(await check(ctx), 'claude-code');
  assert.equal(r.state, 'protected');
  assert.ok(r.notes.some((n) => /prompt hook lets prompts through when it cannot run/.test(n)));
});

test('check: hooks without the prompt-expansion entry get a note, new installs and the plugin do not', async (t) => {
  const ctx = homeWithHooks(t, ['claude-code']);
  const file = getAdapter('claude-code').settingsFile(ctx);
  const fresh = byId(await check(ctx), 'claude-code');
  assert.ok(!fresh.notes.some((n) => /prompt-expansion/.test(n)));
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const old = JSON.parse(JSON.stringify(settings));
  delete old.hooks.UserPromptExpansion;
  fs.writeFileSync(file, JSON.stringify(old));
  const r = byId(await check(ctx), 'claude-code');
  assert.equal(r.state, 'protected');
  assert.ok(r.notes.some((n) => /newer prompt-expansion check.*`zn hooks install claude-code` again/.test(n)));
  // Plugin only: the plugin ships its own hooks, so there is nothing to add.
  const home2 = tempDir(t, 'zn-check-home-');
  fakePlugin(home2, launcher());
  const p = byId(await check({ home: home2, env: { HOME: home2, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-') }), 'claude-code');
  assert.ok(!p.notes.some((n) => /prompt-expansion/.test(n)));
});

test('check: zn hooks without the read hook are not protected', async (t) => {
  const ctx = homeWithHooks(t, ['codex']);
  const file = getAdapter('codex').hooksFile(ctx);
  const tree = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete tree.hooks.PreToolUse;
  fs.writeFileSync(file, JSON.stringify(tree));
  const r = byId(await check(ctx), 'codex');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /not the one that checks reading files \(PreToolUse\)/);
});

test('check: a `zn hook` command with no zn on PATH is not protected', async (t) => {
  const ctx = homeWithHooks(t, ['cursor']);
  const file = getAdapter('cursor').hooksFile(ctx);
  const tree = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const list of Object.values(tree.hooks)) for (const h of list) h.command = 'zn hook cursor';
  fs.writeFileSync(file, JSON.stringify(tree));
  ctx.env = { HOME: ctx.home, PATH: path.join(ctx.home, 'empty-bin') };
  const r = byId(await check(ctx), 'cursor');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /no `zn` on your PATH/);
});

test('check: a command that is not zn\'s exact hook is never run', async (t) => {
  const ctx = homeWithHooks(t, ['cursor']);
  const file = getAdapter('cursor').hooksFile(ctx);
  const marker = path.join(ctx.home, 'ran');
  const tree = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const list of Object.values(tree.hooks)) for (const h of list) h.command = process.platform === 'win32' ? '$(touch ' + marker + ') ' + h.command : h.command.replace(/^'/, "'$(touch " + marker + ")");
  fs.writeFileSync(file, JSON.stringify(tree));
  const r = byId(await check(ctx), 'cursor');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(r.state, 'not-set-up');
});

test('check: the Claude Code plugin is checked through its launcher; a launcher that blocks everything is not protected', async (t) => {
  const home = tempDir(t, 'zn-check-plugin-');
  const env = { HOME: home, PATH: process.env.PATH };
  fakePlugin(home, launcher());
  let r = byId(await check({ home, env, cwd: home }), 'claude-code');
  assert.equal(r.state, 'protected', r.problem);
  assert.equal(r.verified, true);
  fakePlugin(home, launcher({ broken: true }));
  r = byId(await check({ home, env, cwd: home }), 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /blocks everything, ordinary files too/);
  // The plugin alone: no second set to fall back on, so nothing is offered to turn off.
  assert.ok(!r.pluginBroken);
  assert.doesNotMatch(r.fix, /plugin disable/);
});

test('check: a plugin with no hook manifest is not protected, and its launcher is not run', async (t) => {
  const home = tempDir(t, 'zn-check-nomanifest-');
  const marker = path.join(tempDir(t, 'zn-check-nomanifest-mark-'), 'ran.txt');
  const root = fakePlugin(home, launcher({ marker }), null, { manifest: null });
  for (const live of [true, false]) {
    const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live }), 'claude-code');
    assert.equal(r.state, 'not-protected');
    assert.ok(!r.verified);
    assert.match(r.problem, /has no hook manifest zn-gate check can read/);
    assert.match(r.fix, /claude plugin install zn-gate@usezn/);
  }
  // A manifest that is not JSON, or has no "hooks", is the same as none.
  for (const text of ['{', '{"description":"x"}']) {
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), text);
    const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-') }), 'claude-code');
    assert.equal(r.state, 'not-protected', text);
    assert.match(r.problem, /has no hook manifest/, text);
  }
  assert.equal(fs.existsSync(marker), false, 'the launcher of a plugin with no manifest ran');
});

test('check: a plugin manifest whose PreToolUse hook does not run, does not wait, or does not cover reads is not protected', async (t) => {
  const marker = path.join(tempDir(t, 'zn-check-pre-mark-'), 'ran.txt');
  const other = { SessionStart: [{ hooks: [{ type: 'command', shell: 'bash', command: '/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" SessionStart check claude-code' }] }] };
  const withMatcher = (m) => { const h = pluginHooks(); h.hooks.PreToolUse[0].matcher = m; return h; };
  const cases = [
    [{ hooks: other }, /has no PreToolUse hook in .*hooks\.json/],
    [pluginHooks({ enabled: false }), /is turned off/],
    [pluginHooks({ async: true }), /runs in the background \(async\)/],
    [pluginHooks({ asyncRewake: true }), /runs in the background \(async\)/],
    [pluginHooks({ type: 'prompt' }), /is not a "command" hook/],
    [withMatcher('^(Bash|Write)$'), /matcher that does not cover Read/],
    [withMatcher('mcp__.*'), /matcher that does not cover Read/],
  ];
  for (const [manifest, re] of cases) {
    const home = tempDir(t, 'zn-check-pre-');
    fakePlugin(home, launcher({ marker }), null, { manifest });
    const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
    assert.equal(r.state, 'not-protected', JSON.stringify(manifest));
    assert.match(r.problem, re, JSON.stringify(manifest));
    assert.match(r.problem, /so Claude Code runs no zn check before tool calls$/);
  }
  assert.equal(fs.existsSync(marker), false, 'the launcher of a plugin whose manifest was refused ran');
  // A second PreToolUse hook that does cover reads is enough; a matcher of "*" or none covers every tool.
  for (const manifest of [withMatcher('*'), withMatcher(''), { hooks: { PreToolUse: [...pluginHooks({ async: true }).hooks.PreToolUse, ...pluginHooks().hooks.PreToolUse] } }]) {
    const home = tempDir(t, 'zn-check-preok-');
    fakePlugin(home, launcher(), null, { manifest });
    const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
    assert.equal(r.state, 'protected', JSON.stringify(manifest) + ': ' + r.problem);
    assert.equal(r.verified, true);
  }
});

test('check: a plugin listed in a folder inside the project is not protected, and its launcher is not run', async (t) => {
  const home = tempDir(t, 'zn-check-projplug-');
  const project = tempDir(t, 'zn-check-projplug-repo-');
  fs.mkdirSync(path.join(project, '.git'));
  fs.mkdirSync(path.join(project, 'sub'));
  const marker = path.join(tempDir(t, 'zn-check-projplug-mark-'), 'ran.txt');
  const root = fakePlugin(home, launcher({ marker }), null, { root: path.join(project, 'plugin') });
  // From the project folder, and from a folder below it in the same repository.
  for (const cwd of [project, path.join(project, 'sub')]) {
    for (const live of [true, false]) {
      const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd, live }), 'claude-code');
      assert.equal(r.state, 'not-protected', cwd);
      assert.ok(!r.verified);
      assert.match(r.problem, /not inside the folder where Claude Code installs plugins/, cwd);
    }
  }
  // Claude Code's configuration folder moved into the project (CLAUDE_CONFIG_DIR): its plugins are still the project's.
  const moved = path.join(project, 'claude-config');
  fs.mkdirSync(path.join(moved, 'plugins'), { recursive: true });
  const inMoved = path.join(moved, 'plugins', 'cache', 'usezn', 'zn-gate', '1.8.1');
  fakePlugin(home, launcher({ marker }), null, { root: inMoved });
  fs.copyFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), path.join(moved, 'plugins', 'installed_plugins.json'));
  const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: moved }, cwd: project, live: true }), 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /inside this project/);
  assert.equal(fs.existsSync(marker), false, 'zn-gate check ran a launcher from the project');
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'zn-launch.js')));
  // Run from the home folder, or from a configuration folder kept in git, the installed plugin still counts.
  fakePlugin(home, launcher());
  fs.mkdirSync(path.join(home, '.claude', '.git'), { recursive: true });
  for (const cwd of [home, path.join(home, '.claude'), path.join(home, '.claude', 'plugins')]) {
    const ok = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd, live: true }), 'claude-code');
    assert.equal(ok.state, 'protected', cwd + ': ' + ok.problem);
  }
});

test('check: a plugin outside the folder where Claude Code installs plugins is not protected; the plugin cache folder counts', async (t) => {
  const home = tempDir(t, 'zn-check-outplug-');
  const elsewhere = tempDir(t, 'zn-check-outplug-dir-');
  const marker = path.join(tempDir(t, 'zn-check-outplug-mark-'), 'ran.txt');
  fakePlugin(home, launcher({ marker }), null, { root: path.join(elsewhere, 'zn-gate') });
  const env = { HOME: home, PATH: process.env.PATH };
  let r = byId(await check({ home, env, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /not inside the folder where Claude Code installs plugins/);
  assert.equal(fs.existsSync(marker), false, 'zn-gate check ran a launcher outside the plugins folder');
  // A link inside the plugins folder that leads out of it does not pass either.
  if (process.platform !== 'win32') {
    const link = path.join(home, '.claude', 'plugins', 'cache', 'linked');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(elsewhere, 'zn-gate'), link);
    fakePlugin(home, launcher({ marker }), null, { root: link });
    r = byId(await check({ home, env, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
    assert.equal(r.state, 'not-protected');
    assert.match(r.problem, /not inside the folder where Claude Code installs plugins/);
    assert.equal(fs.existsSync(marker), false);
  }
  // Claude Code keeps its plugins under CLAUDE_CODE_PLUGIN_CACHE_DIR when it is set.
  fakePlugin(home, launcher(), null, { root: path.join(elsewhere, 'zn-gate') });
  r = byId(await check({ home, env: { ...env, CLAUDE_CODE_PLUGIN_CACHE_DIR: elsewhere }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
  assert.equal(r.state, 'protected', r.problem);
  assert.equal(r.verified, true);
});

test('check: the plugin\'s own check message, a plugin turned off, and a disableAllHooks setting are not protected', async (t) => {
  const home = tempDir(t, 'zn-check-plugin2-');
  const env = { HOME: home, PATH: process.env.PATH };
  fakePlugin(home, launcher({ systemMessage: 'zn plugin: zn-gate 1.8.1 is not installed. Run: npm i -g zn-gate@1.8.1' }));
  let r = byId(await check({ home, env, cwd: home }), 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /npm i -g zn-gate@1\.8\.1/);
  fakePlugin(home, launcher(), { enabledPlugins: { 'zn-gate@usezn': false } });
  r = byId(await check({ home, env, cwd: home }), 'claude-code');
  assert.match(r.problem, /turned off/);
  fakePlugin(home, launcher(), { disableAllHooks: true });
  r = byId(await check({ home, env, cwd: home }), 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /disableAllHooks/);
});

test('check: a setup for one project only is reported, not run, and not counted as protected', async (t) => {
  const home = tempDir(t, 'zn-check-proj-');
  const proj = tempDir(t, 'zn-check-repo-');
  getAdapter('codex').install({ scope: 'project', projectDir: proj, home, env: { HOME: home }, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  const res = await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: proj });
  const r = byId(res, 'codex');
  assert.equal(r.state, 'project-only');
  const { s, code } = textOf(res);
  assert.equal(code, 1);
  assert.match(s, /set up only for one project/);
});

test('check: a project file that is a FIFO or a symlink is not read, and relative PATH entries are ignored', { skip: process.platform === 'win32' }, async (t) => {
  const home = tempDir(t, 'zn-check-fifo-');
  const proj = tempDir(t, 'zn-check-fiforepo-');
  fs.mkdirSync(path.join(proj, '.codex'), { recursive: true });
  require('child_process').spawnSync('mkfifo', [path.join(proj, '.codex', 'hooks.json')]);
  fs.mkdirSync(path.join(proj, '.cursor'), { recursive: true });
  fs.symlinkSync('/etc/hostname', path.join(proj, '.cursor', 'hooks.json'));
  const started = Date.now();
  const res = await check({ home, env: { HOME: home, PATH: 'relbin:' + process.env.PATH }, cwd: proj });
  assert.ok(Date.now() - started < 10000, 'a FIFO in the project never blocks the check');
  assert.equal(byId(res, 'codex').state, 'not-set-up');
  assert.equal(byId(res, 'cursor').state, 'not-set-up');
});

test('check: a `zn hook` command does not find zn through a relative PATH entry', async (t) => {
  const ctx = homeWithHooks(t, ['cursor']);
  const file = getAdapter('cursor').hooksFile(ctx);
  const tree = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const list of Object.values(tree.hooks)) for (const h of list) h.command = 'zn hook cursor';
  fs.writeFileSync(file, JSON.stringify(tree));
  const rel = path.join(ctx.cwd, 'relbin');
  fs.mkdirSync(rel);
  fs.writeFileSync(path.join(rel, process.platform === 'win32' ? 'zn.cmd' : 'zn'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const saved = process.cwd();
  process.chdir(ctx.cwd);
  try {
    ctx.env = { HOME: ctx.home, PATH: 'relbin' };
    const r = byId(await check(ctx), 'cursor');
    assert.equal(r.state, 'not-protected');
    assert.match(r.problem, /no `zn` on your PATH/);
  } finally {
    process.chdir(saved);
  }
});

test('check: a hook whose zn-gate files are gone gets the same repair', async (t) => {
  const ctx = legacyCodexHome(t);
  const file = getAdapter('codex').hooksFile(ctx);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(RUNNER.replace(/\\/g, '/')).join(path.join(ctx.home, 'gone', 'zn-gate', 'lib', 'hooks', 'runner.js').replace(/\\/g, '/')));
  const r = byId(await check(ctx), 'codex');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /its zn-gate files .* is no longer there/);
  assert.match(r.fix, /^install zn-gate again for the Node\.js you use now: run `npm install -g zn-gate`/);
});

test('check: the plugin together with zn hooks is not protected, and the fix removes the hooks', async (t) => {
  const ctx = homeWithHooks(t, ['claude-code']);
  const settings = JSON.parse(fs.readFileSync(getAdapter('claude-code').settingsFile(ctx), 'utf8'));
  fakePlugin(ctx.home, launcher(), settings);
  const r = byId(await check(ctx), 'claude-code');
  assert.equal(r.via, 'both');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /plugin and the hooks of `zn hooks install claude-code` are both set up/);
  assert.equal(r.fix, 'remove the second set: run `zn hooks uninstall claude-code` in your own terminal');
  assert.ok(!r.notes.some((n) => /prompt hook/.test(n)));
});

// zn's own rules letting the fake .env through (as a damaged zn-gate install would): the fix is zn-gate itself,
// never "install the plugin" for a plugin that is already there.
async function withRulesThatAllow(t, fn) {
  const runner = require('../lib/hooks/runner');
  const real = runner.handle;
  runner.handle = async () => ({ decision: { decision: 'allow' } });
  t.after(() => { runner.handle = real; });
  return fn();
}

test('check: zn rules that do not block .env, with the plugin alone or next to zn hooks, are fixed by reinstalling zn-gate', async (t) => {
  const alone = homeWithHooks(t, []);
  fs.mkdirSync(path.join(alone.home, '.claude'), { recursive: true });
  fakePlugin(alone.home, launcher());
  const both = homeWithHooks(t, ['claude-code']);
  fakePlugin(both.home, launcher(), JSON.parse(fs.readFileSync(getAdapter('claude-code').settingsFile(both), 'utf8')));
  await withRulesThatAllow(t, async () => {
    for (const [ctx, via] of [[alone, 'plugin'], [both, 'both']]) {
      const r = byId(await check(ctx), 'claude-code');
      assert.equal(r.via, via);
      assert.equal(r.state, 'not-protected');
      assert.equal(r.problem, 'zn did not block the read of .env');
      assert.equal(r.fix, 'install zn-gate again: run `npm install -g zn-gate` in your own terminal, then run `zn-gate check` again');
      assert.ok(!r.duplicate);
    }
    const hooks = byId(await check(homeWithHooks(t, ['codex'])), 'codex');
    assert.equal(hooks.problem, 'zn did not block the read of .env');
    assert.match(hooks.fix, /npm install -g zn-gate/);
  });
});

test('check: the plugin alone keeps the plugin fix', async (t) => {
  const ctx = homeWithHooks(t, []);
  fs.mkdirSync(path.join(ctx.home, '.claude'), { recursive: true });
  fakePlugin(ctx.home, launcher());
  const r = byId(await check(ctx), 'claude-code');
  assert.equal(r.via, 'plugin');
  assert.equal(r.state, 'protected');
  assert.match(r.fix, /claude plugin install zn-gate@usezn/);
});

test('check: a plugin that is turned off next to zn hooks: the hooks are checked, nothing is offered for removal', async (t) => {
  const ctx = homeWithHooks(t, ['claude-code']);
  const settings = JSON.parse(fs.readFileSync(getAdapter('claude-code').settingsFile(ctx), 'utf8'));
  fakePlugin(ctx.home, launcher(), { ...settings, enabledPlugins: { 'zn-gate@usezn': false } });
  const r = byId(await check(ctx), 'claude-code');
  assert.equal(r.via, 'hooks');
  assert.equal(r.state, 'protected');
  assert.ok(!r.pluginBroken);
  assert.ok(r.notes.includes('the zn-gate plugin is also installed, but turned off'));
  assert.doesNotMatch(r.fix, /uninstall/);
});

test('check: a plugin alone that is turned off is fixed by turning it on', async (t) => {
  const ctx = homeWithHooks(t, []);
  fs.mkdirSync(path.join(ctx.home, '.claude'), { recursive: true });
  fakePlugin(ctx.home, launcher(), { enabledPlugins: { 'zn-gate@usezn': false } });
  const r = byId(await check(ctx), 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.equal(r.pluginOff, true);
  assert.equal(r.fix, 'turn it on: run `claude plugin enable zn-gate@usezn` in your own terminal');
});

test('check: a broken plugin next to zn hooks is turned off, not the hooks removed', async (t) => {
  const ctx = homeWithHooks(t, ['claude-code']);
  const settings = JSON.parse(fs.readFileSync(getAdapter('claude-code').settingsFile(ctx), 'utf8'));
  fakePlugin(ctx.home, launcher({ broken: true }), settings);
  const r = byId(await check(ctx), 'claude-code');
  assert.equal(r.via, 'both');
  assert.equal(r.pluginBroken, true);
  assert.equal(r.hooksBroken, false);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /the zn-gate plugin does not work here \(.+\), while the hooks of `zn hooks install claude-code` next to it do$/);
  assert.match(r.fix, /claude plugin disable zn-gate@usezn/);
  assert.doesNotMatch(r.fix, /hooks uninstall|npm install/);
});

test('check: a plugin whose own check message reports a fault, next to working zn hooks, is turned off', async (t) => {
  const ctx = homeWithHooks(t, ['claude-code']);
  const settings = JSON.parse(fs.readFileSync(getAdapter('claude-code').settingsFile(ctx), 'utf8'));
  fakePlugin(ctx.home, launcher({ systemMessage: 'zn plugin: this Node.js is not supported. Run: npm i -g zn-gate@1.8.1.' }), settings);
  const r = byId(await check(ctx), 'claude-code');
  assert.equal(r.pluginBroken, true);
  assert.equal(r.hooksBroken, false);
  // The quoted message loses its full stop: no "." just before the closing parenthesis.
  assert.doesNotMatch(r.problem, /\.\)/);
  assert.match(r.problem, /\(zn plugin: this Node\.js is not supported\. Run: npm i -g zn-gate@1\.8\.1\)/);
  assert.match(r.fix, /^turn the plugin off, which keeps those hooks: run `claude plugin disable zn-gate@usezn`/);
});

test('check: a broken plugin next to zn hooks that do not work either: repair the hooks first, then turn the plugin off', async (t) => {
  const ctx = homeWithHooks(t, []);
  getAdapter('claude-code').install({ scope: 'user', home: ctx.home, env: ctx.env, nodePath: '/nonexistent/bin/node', runnerPath: RUNNER, mcp: false });
  const settings = JSON.parse(fs.readFileSync(getAdapter('claude-code').settingsFile(ctx), 'utf8'));
  fakePlugin(ctx.home, launcher({ broken: true }), settings);
  const r = byId(await check(ctx), 'claude-code');
  assert.equal(r.via, 'both');
  assert.equal(r.pluginBroken, true);
  assert.equal(r.hooksBroken, true);
  assert.equal(r.state, 'not-protected');
  // Nothing claims the hooks protect the agent: they were checked and they do not.
  assert.match(r.problem, /do not work either \(its hook cannot start: its Node\.js .* is no longer there/);
  assert.doesNotMatch(r.problem + r.fix, /keep protecting|keeps those hooks/);
  const npm = r.fix.indexOf('npm install -g zn-gate');
  const hooks = r.fix.indexOf('zn hooks install claude-code');
  const off = r.fix.indexOf('claude plugin disable zn-gate@usezn');
  assert.ok(npm >= 0 && npm < hooks && hooks < off, r.fix);
});

test('check: zn hooks without their read hook next to a broken plugin count as broken hooks', async (t) => {
  const ctx = homeWithHooks(t, ['claude-code']);
  const file = getAdapter('claude-code').settingsFile(ctx);
  const tree = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete tree.hooks.PreToolUse;
  fakePlugin(ctx.home, launcher({ broken: true }), tree);
  const r = byId(await check(ctx), 'claude-code');
  assert.equal(r.pluginBroken, true);
  assert.equal(r.hooksBroken, true);
  assert.match(r.problem, /not the one that checks reading files \(PreToolUse\)/);
  assert.ok(r.fix.indexOf('zn hooks install claude-code') < r.fix.indexOf('claude plugin disable'));
});

test('check: a Claude Code setting that stops all hooks, with the plugin and zn hooks, is not blamed on the plugin', async (t) => {
  const ctx = homeWithHooks(t, ['claude-code']);
  const settings = JSON.parse(fs.readFileSync(getAdapter('claude-code').settingsFile(ctx), 'utf8'));
  fakePlugin(ctx.home, launcher(), { ...settings, disableAllHooks: true });
  const r = byId(await check(ctx), 'claude-code');
  assert.equal(r.via, 'both');
  assert.equal(r.state, 'not-protected');
  assert.ok(!r.pluginBroken);
  assert.ok(!r.duplicate);
  assert.match(r.problem, /disableAllHooks/);
  assert.doesNotMatch(r.problem, /plugin does not work|both set up/);
  assert.doesNotMatch(r.fix, /plugin disable|hooks uninstall|hooks install/);
  // Also when the plugin is broken as well: the setting comes first, it stops both sets.
  fakePlugin(ctx.home, launcher({ broken: true }), { ...settings, disableAllHooks: true });
  const b = byId(await check(ctx), 'claude-code');
  assert.ok(!b.pluginBroken);
  assert.match(b.problem, /disableAllHooks/);
});

test('check: a plugin turned off next to broken zn hooks: the hooks are repaired, the plugin is not called broken', async (t) => {
  const ctx = homeWithHooks(t, []);
  getAdapter('claude-code').install({ scope: 'user', home: ctx.home, env: ctx.env, nodePath: '/nonexistent/bin/node', runnerPath: RUNNER, mcp: false });
  const settings = JSON.parse(fs.readFileSync(getAdapter('claude-code').settingsFile(ctx), 'utf8'));
  fakePlugin(ctx.home, launcher({ broken: true }), { ...settings, enabledPlugins: { 'zn-gate@usezn': false } });
  const r = byId(await check(ctx), 'claude-code');
  assert.equal(r.via, 'hooks');
  assert.equal(r.state, 'not-protected');
  assert.ok(!r.pluginBroken);
  assert.match(r.fix, /npm install -g zn-gate`, then `zn hooks install claude-code`/);
  assert.doesNotMatch(r.fix, /plugin/);
});

test('check: a Claude Code plugin whose hooks.json starts a hook with a program by name is not protected', { skip: process.platform === 'win32' && 'on Windows the missing "shell": "bash" of the SessionStart hook is reported first' }, async (t) => {
  const hooksJson = (cmd) => JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: '/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" SessionStart check claude-code' }] }],
    PreToolUse: [{ matcher: '^(Bash|Read)$', hooks: [{ type: 'command', command: cmd, onFailure: 'block' }] }],
  } });
  const cases = [
    ['node "${CLAUDE_PLUGIN_ROOT}/scripts/zn-launch.js" hook claude-code', 'node'],
    ['"node" "${CLAUDE_PLUGIN_ROOT}/scripts/zn-launch.js" hook claude-code', 'node'],
    ['sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse hook claude-code', 'sh'],
  ];
  for (const [cmd, prog] of cases) {
    const home = tempDir(t, 'zn-check-ccbare-');
    const root = fakePlugin(home, launcher());
    fs.writeFileSync(path.join(root, 'scripts', 'zn-node.sh'), '#!/bin/sh\n', { mode: 0o755 });
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), hooksJson(cmd));
    const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
    assert.equal(r.state, 'not-protected', cmd);
    assert.match(r.problem, new RegExp('starts its PreToolUse hook with `' + prog + '` by name'), cmd);
    assert.match(r.fix, /claude plugin update zn-gate@usezn/, cmd);
  }
  // The shell by its full path, with the plugin root in quotes: no program by name. Without "shell": "bash" it is still
  // not the hook the plugin ships; with it (and the plugin's real zn-node.sh), the plugin is protected.
  const home = tempDir(t, 'zn-check-ccabs-');
  const root = fakePlugin(home, launcher());
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), hooksJson('/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse hook claude-code'));
  const noShell = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
  assert.equal(noShell.state, 'not-protected');
  assert.match(noShell.problem, /does not ask for bash \("shell": "bash"\)/);
  assert.doesNotMatch(noShell.problem, /by name/);
  const withShell = JSON.parse(hooksJson('/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse hook claude-code'));
  withShell.hooks.PreToolUse[0].hooks[0].shell = 'bash';
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify(withShell));
  const ok = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
  assert.equal(ok.state, 'protected', ok.problem);
  assert.equal(ok.verified, true);
});

test('check: only an absolute sh or node running a script inside the plugin folder counts; every other plugin hook is not protected', async (t) => {
  const hooksJson = (cmd) => JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: cmd, onFailure: 'block' }] }] } });
  const L = '"${CLAUDE_PLUGIN_ROOT}/scripts/zn-launch.js" hook claude-code';
  const S = '"${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse hook claude-code';
  const unsafe = [
    // a program by name, or one that looks the next one up
    ['env node ' + L, /`env` by name/],
    ['./bin/node ' + L, /`\.\/bin\/node` by name/],
    ['$HOME/node ' + L, /by name/],
    ['/usr/bin/env sh x', /`env`, which looks the program/],
    ['/usr/bin/env node ' + L, /`env`, which looks the program/],
    ['/usr/bin/env -i FOO=1 node ' + L, /`env`, which looks the program/],
    ['/usr/bin/env -u /x node ' + L, /`env`, which looks the program/],
    ['/usr/bin/env -C /x node ' + L, /`env`, which looks the program/],
    ['/usr/bin/env /bin/sh ' + S, /`env`, which looks the program/],
    ['/usr/bin/env', /`env`, which looks the program/],
    ...['nohup', 'timeout 10', 'nice', 'sudo', 'xargs', 'stdbuf -o0', 'setsid', 'time', 'flock /x', 'arch -arm64', 'xcrun']
      .map((w) => ['/usr/bin/' + w + ' node ' + L, /not a system shell running a script inside the plugin folder/]),
    // code given inline
    ['/bin/sh -c "node x"', /code given inline \(`sh -c`\)/],
    ['/bin/bash -ec "node x"', /code given inline \(`bash -ec`\)/],
    ['/bin/bash -o pipefail -c "node x"', /code given inline \(`bash -c`\)/],
    ['/bin/sh +e -c "node x"', /code given inline \(`sh -c`\)/],
    ['/bin/busybox sh -c "node x"', /code given inline \(`busybox -c`\)/],
    ['/usr/bin/fish -c "node x"', /code given inline/],
    ['/bin/tcsh -c "node x"', /code given inline/],
    ['/bin/rbash -c "node x"', /code given inline/],
    ['/usr/bin/python3 -c "import os"', /code given inline/],
    ['/usr/bin/perl -e 1', /code given inline/],
    ['/usr/bin/node -e 1', /code given inline \(`node -e`\)/],
    ['/usr/bin/node ' + L, /not a system shell running a script/],
    // no script, or a script outside the plugin folder
    ['/bin/sh', /not a system shell running a script/],
    ['/bin/sh -s', /not a system shell running a script/],
    ['/bin/sh -', /not a system shell running a script/],
    ['/bin/sh ./scripts/zn-node.sh x', /not a system shell running a script/],
    ['/bin/sh scripts/zn-node.sh x', /not a system shell running a script/],
    ['/bin/sh ../x.sh', /not a system shell running a script/],
    ['/bin/sh "${CLAUDE_PLUGIN_ROOT}/../x.sh"', /not a system shell running a script/],
    ['/bin/sh /opt/x.sh', /not a system shell running a script/],
    ['/bin/sh "$PLUGIN_ROOT/scripts/zn-node.sh"', /not a system shell running a script/],
    ['/usr/bin/node scripts/zn-launch.js hook claude-code', /not a system shell running a script/],
    ['/usr/bin/python3 ' + L, /not a system shell running a script/],
    // assignments in front, shell lines, a quote never closed
    ['BASH_ENV=./x /bin/bash ' + S, /NAME=value in front of the program \(BASH_ENV\)/],
    ['FOO=1 /bin/sh ' + S, /NAME=value in front/],
    ['ZN_X=1 node ' + L, /NAME=value in front/],
    ['/bin/true; node ' + L, /shell command line/],
    ['/bin/true && node ' + L, /shell command line/],
    ['/bin/true|node ' + L, /shell command line/],
    ['/bin/sh ' + S + ' > /dev/null', /shell command line/],
    ['FOO=$(node) /bin/sh ' + S, /shell command line/],
    ['/bin/sh "$(node)"', /shell command line/],
    ['/bin/sh `node`', /shell command line/],
    ["/bin/sh 'x", /backslash, a single quote or a control character/],
    ['/bin/sh "x', /a quote that is never closed, so the hook does not start$/],
    // B4: the shell keeps a backslash inside double quotes, so these name another program or folder
    ['"\\/bin/sh" ' + S, /backslash, a single quote or a control character/],
    ['/bin/sh "\\${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse hook claude-code', /backslash/],
    ['/bin/sh \\\n "${CLAUDE_PLUGIN_ROOT}/x.sh"', /backslash/],
    ["/bin/sh '${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh' PreToolUse hook claude-code", /single quote/],
    ['/bin/sh "${CLAUDE_PLUGIN_ROOT}/x.sh"\tPreToolUse', /control character/],
    ['/bin/sh "${CLAUDE_PLUGIN_ROOT}/x.sh"\nnode x', /control character/],
  ];
  for (const [cmd, re] of unsafe) {
    const home = tempDir(t, 'zn-check-ccb3-');
    const root = fakePlugin(home, launcher());
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), hooksJson(cmd));
    const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
    assert.equal(r.state, 'not-protected', cmd);
    assert.match(r.problem, re, cmd);
  }
  // The safe program forms (also with shell syntax inside quotes) start no program by name, but only the exact hook the
  // plugin ships counts (with "shell": "bash"), so these are reported for that, not for a program by name.
  const safe = [
    ['/bin/sh ' + S, /does not ask for bash \("shell": "bash"\)/],
    ['/bin/bash ' + S, /which is not the hook the zn-gate plugin ships/],
    ['/bin/sh "${CLAUDE_PLUGIN_ROOT}/a;b|c.sh" "x && y"', /which is not the hook the zn-gate plugin ships/],
  ];
  if (process.platform !== 'win32') {
    for (const [cmd, re] of safe) {
      const home = tempDir(t, 'zn-check-ccb3ok-');
      const root = fakePlugin(home, launcher());
      fs.writeFileSync(path.join(root, 'a;b|c.sh'), '#!/bin/sh\n', { mode: 0o755 });
      fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), hooksJson(cmd));
      const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
      assert.equal(r.state, 'not-protected', cmd);
      assert.match(r.problem, re, cmd);
      assert.doesNotMatch(r.problem, /by name|not a system shell/, cmd);
    }
  }
});

test('check: on Windows a Claude Code plugin hook counts only when it runs with bash ("shell": "bash")', (t) => {
  const { pluginManifest } = require('../lib/check')._internal;
  const root = tempDir(t, 'zn-check-ccwin-');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'zn-node.sh'), '#!/bin/sh\n');
  const write = (hook) => {
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [hook] }] } }));
  };
  const cmd = '/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse hook claude-code';
  write({ type: 'command', command: cmd });
  assert.match(pluginManifest(root, 'CLAUDE_PLUGIN_ROOT', 'win32').bare.byName, /default Windows shell of Claude Code/);
  assert.equal(pluginManifest(root, 'CLAUDE_PLUGIN_ROOT', 'linux').bare, null);
  write({ type: 'command', command: cmd, shell: 'bash' });
  assert.equal(pluginManifest(root, 'CLAUDE_PLUGIN_ROOT', 'win32').bare, null);
  write({ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/x.js"', shell: 'bash' });
  assert.match(pluginManifest(root, 'CLAUDE_PLUGIN_ROOT', 'win32').bare.byName, /`node` by name/);
  write({ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/x.js"' });
  assert.match(pluginManifest(root, 'CLAUDE_PLUGIN_ROOT', 'win32').bare.byName, /`node` by name/);
});

test('check: a plugin hook is NOT protected, and nothing it names runs, when its shell is not a system shell, it uses a pattern, or its script links out of the plugin', { skip: process.platform === 'win32' }, async (t) => {
  const hooksJson = (cmd) => JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: cmd, onFailure: 'block' }] }] } });
  const S = '"${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse hook claude-code';
  const project = tempDir(t, 'zn-check-strict-proj-');
  const marker = path.join(project, 'ran.txt');
  const planted = '#!/bin/sh\necho ran >> ' + JSON.stringify(marker) + '\nexit 0\n';
  fs.writeFileSync(path.join(project, 'sh'), planted, { mode: 0o755 });
  fs.writeFileSync(path.join(project, 'evil.sh'), planted, { mode: 0o755 });
  const cases = [
    // an absolute sh that is not a system shell (a file in the project)
    [path.join(project, 'sh') + ' ' + S, /not a system shell running a script inside the plugin folder/, null],
    // a pattern the shell expands to some sh
    ['/*/sh ' + S, /a pattern the shell or the host expands/, null],
    ['/bin/s? ' + S, /a pattern the shell or the host expands/, null],
    // the script is a link inside the plugin to a file in the project
    ['/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/link.sh" PreToolUse hook claude-code', /not a file inside the plugin folder/, 'link'],
    // the script does not exist
    ['/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/missing.sh" PreToolUse hook claude-code', /is missing/, null],
  ];
  for (const [cmd, re, kind] of cases) {
    const home = tempDir(t, 'zn-check-strict-');
    const root = fakePlugin(home, launcher());
    fs.writeFileSync(path.join(root, 'scripts', 'zn-node.sh'), planted, { mode: 0o755 });
    if (kind === 'link') fs.symlinkSync(path.join(project, 'evil.sh'), path.join(root, 'scripts', 'link.sh'));
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), hooksJson(cmd));
    const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
    assert.equal(r.state, 'not-protected', cmd);
    assert.match(r.problem, re, cmd);
  }
  assert.equal(fs.existsSync(marker), false, 'a program or script named by a refused manifest ran');
});

// The plugin's real hooks file and launcher script in this repository.
const REPO_PLUGIN = path.join(__dirname, '..', '..', '..', 'plugins', 'zn-gate');
const { CLAUDE_PRE_COMMAND, claudePluginRun } = require('../lib/check')._internal;

test('check: only the PreToolUse hook the plugin ships counts; a decoy script in the plugin is not run and is not protected', { skip: process.platform === 'win32' }, async (t) => {
  const marker = path.join(tempDir(t, 'zn-check-decoy-mark-'), 'ran.txt');
  const noop = (root) => fs.writeFileSync(path.join(root, 'scripts', 'noop.sh'), '#!/bin/sh\necho noop >> ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
  const cmd = (c) => pluginHooks({ command: c });
  const cases = [
    // A script of the plugin's own folder that answers nothing (exit 0): Claude Code would run the call unchecked.
    [cmd('/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/noop.sh" PreToolUse hook claude-code'), /runs `\/bin\/sh "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/noop\.sh" PreToolUse hook claude-code`, which is not the hook the zn-gate plugin ships/],
    [cmd(CLAUDE_PRE_COMMAND + ' --extra'), /which is not the hook the zn-gate plugin ships/],
    [cmd('/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse check claude-code'), /which is not the hook the zn-gate plugin ships/],
    [cmd('/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PostToolUse hook claude-code'), /which is not the hook the zn-gate plugin ships/],
    [cmd('/bin/bash "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse hook claude-code'), /which is not the hook the zn-gate plugin ships/],
    [pluginHooks({ onFailure: undefined }), /does not have "onFailure": "block", so Claude Code runs a call unchecked when the hook cannot run$/],
    [pluginHooks({ onFailure: 'warn' }), /does not have "onFailure": "block"/],
    [pluginHooks({ shell: undefined }), /does not ask for bash \("shell": "bash"\)/],
  ];
  for (const [manifest, re] of cases) {
    for (const live of [true, false]) {
      const home = tempDir(t, 'zn-check-decoy-');
      const root = fakePlugin(home, launcher({ marker }), null, { manifest });
      noop(root);
      const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live }), 'claude-code');
      assert.equal(r.state, 'not-protected', JSON.stringify(manifest));
      assert.ok(!r.verified);
      assert.match(r.problem, re, JSON.stringify(manifest));
      assert.match(r.fix, /claude plugin install zn-gate@usezn/);
    }
  }
  assert.equal(fs.existsSync(marker), false, 'zn-gate check ran the decoy script or the launcher of a refused manifest');
});

test('check: the plugin\'s exact PreToolUse command is what runs; a zn-node.sh that answers nothing is not protected', { skip: process.platform === 'win32' }, async (t) => {
  const home = tempDir(t, 'zn-check-inert-');
  const marker = path.join(tempDir(t, 'zn-check-inert-mark-'), 'ran.txt');
  const root = fakePlugin(home, launcher({ marker }));
  // The manifest is the shipped one, but its script exits 0 without asking zn: not a script zn ships, so it is not run.
  const inert = '#!/bin/sh\nexit 0\n';
  fs.writeFileSync(path.join(root, 'scripts', 'zn-node.sh'), inert, { mode: 0o755 });
  let r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-') }), 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.ok(!r.verified);
  assert.match(r.problem, /is not one zn-gate ships/);
  assert.equal(fs.existsSync(marker), false, 'zn-gate check ran zn-launch.js itself instead of the manifest command');
  // Even were it a shipped script, the live run of the manifest command would show it blocks nothing.
  const { PUBLISHED_PLUGIN_SCRIPTS } = require('../lib/check')._internal;
  const inertSha = require('crypto').createHash('sha256').update(inert).digest('hex');
  PUBLISHED_PLUGIN_SCRIPTS['zn-node.sh'].push(inertSha);
  t.after(() => PUBLISHED_PLUGIN_SCRIPTS['zn-node.sh'].splice(PUBLISHED_PLUGIN_SCRIPTS['zn-node.sh'].indexOf(inertSha), 1));
  r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-') }), 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /did not block the read of \.env/);
  assert.equal(fs.existsSync(marker), false);
  // With the real zn-node.sh back, the same manifest command starts the launcher, and the plugin is protected.
  fs.copyFileSync(path.join(REPO_PLUGIN, 'scripts', 'zn-node.sh'), path.join(root, 'scripts', 'zn-node.sh'));
  r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-') }), 'claude-code');
  assert.equal(r.state, 'protected', r.problem);
  assert.equal(r.verified, true);
  assert.ok(fs.existsSync(marker), 'the manifest command did not start the plugin launcher');
});

test('check: the published plugin manifest with the real zn-node.sh is protected and verified', { skip: process.platform === 'win32' }, async (t) => {
  const home = tempDir(t, 'zn-check-published-');
  const published = JSON.parse(fs.readFileSync(path.join(REPO_PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const root = fakePlugin(home, launcher(), null, { manifest: published });
  assert.equal(fs.readFileSync(path.join(root, 'scripts', 'zn-node.sh'), 'utf8'), fs.readFileSync(path.join(REPO_PLUGIN, 'scripts', 'zn-node.sh'), 'utf8'));
  assert.equal(published.hooks.PreToolUse[0].hooks[0].command, CLAUDE_PRE_COMMAND);
  // The absolute folder of this Node.js on the PATH, as zn-node.sh only takes node from absolute entries.
  const PATH = path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '');
  const r = byId(await check({ home, env: { HOME: home, PATH }, cwd: tempDir(t, 'zn-check-cwd-') }), 'claude-code');
  assert.equal(r.state, 'protected', r.problem);
  assert.equal(r.verified, true);
});

test('check: the published hook scripts of this repository are in the list check trusts', () => {
  const { PUBLISHED_PLUGIN_SCRIPTS } = require('../lib/check')._internal;
  const sha = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const repo = path.join(__dirname, '..', '..', '..', 'plugins');
  assert.ok(PUBLISHED_PLUGIN_SCRIPTS['zn-node.sh'].includes(sha(path.join(repo, 'zn-gate', 'scripts', 'zn-node.sh'))),
    'plugins/zn-gate/scripts/zn-node.sh changed: add its sha256 to PUBLISHED_PLUGIN_SCRIPTS in lib/check.js (keep the old one)');
  assert.ok(PUBLISHED_PLUGIN_SCRIPTS['zn-hook.sh'].includes(sha(path.join(repo, 'zcode', 'scripts', 'zn-hook.sh'))),
    'plugins/zcode/scripts/zn-hook.sh changed: add its sha256 to PUBLISHED_PLUGIN_SCRIPTS in lib/check.js (keep the old one)');
});

test('check: a changed zn-node.sh is not run; a plugin newer than this zn-gate asks to update zn-gate', { skip: process.platform === 'win32' }, async (t) => {
  const marker = path.join(tempDir(t, 'zn-check-hash-mark-'), 'ran.txt');
  for (const [version, fixRe] of [['1.0.0', /install the zn-gate plugin again|reinstall|claude plugin/i], ['99.0.0', /npm install -g zn-gate/]]) {
    const home = tempDir(t, 'zn-check-hash-');
    const root = fakePlugin(home, launcher({ marker }));
    // The shipped script with one line added: it would still run zn, but it is not the file zn ships.
    fs.appendFileSync(path.join(root, 'scripts', 'zn-node.sh'), 'echo changed >> ' + JSON.stringify(marker) + '\n');
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'zn-gate', version }));
    const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
    assert.equal(r.state, 'not-protected', version);
    assert.match(r.problem, /is not one zn-gate ships \(sha256 [0-9a-f]{12}\)/, version);
    assert.match(r.fix, fixRe, version);
    if (version === '99.0.0') assert.match(r.problem, /newer than this zn-gate/);
  }
  assert.equal(fs.existsSync(marker), false, 'zn-gate check ran a changed plugin script');
});

test('check: versionNewer compares x.y.z and puts a pre-release below its release', () => {
  const { versionNewer } = require('../lib/check')._internal;
  assert.equal(versionNewer('1.15.0', '1.14.0'), true);
  assert.equal(versionNewer('1.14.0', '1.14.0'), false);
  assert.equal(versionNewer('1.14.0', '1.14.0-rc.2'), true);
  assert.equal(versionNewer('1.14.0-rc.2', '1.14.0'), false);
  assert.equal(versionNewer('2.0.0', '1.99.99'), true);
  assert.equal(versionNewer('x', '1.0.0'), false);
});

test('check: run from a subfolder of a project with its bin/ on the PATH, the plugin hook does not start the project node', { skip: process.platform === 'win32' }, async (t) => {
  const home = tempDir(t, 'zn-check-subdir-');
  const project = tempDir(t, 'zn-check-subdir-repo-');
  fs.mkdirSync(path.join(project, '.git'));
  fs.mkdirSync(path.join(project, 'bin'));
  fs.mkdirSync(path.join(project, 'src', 'deep'), { recursive: true });
  const marker = path.join(tempDir(t, 'zn-check-subdir-mark-'), 'ran.txt');
  // A fake node in the project's bin/: it would answer nothing (exit 0) and leave a marker.
  fs.writeFileSync(path.join(project, 'bin', 'node'), '#!/bin/sh\necho ran > ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
  const published = JSON.parse(fs.readFileSync(path.join(REPO_PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  fakePlugin(home, launcher(), null, { manifest: published });
  const PATH = path.join(project, 'bin') + path.delimiter + path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '');
  for (const cwd of [project, path.join(project, 'src'), path.join(project, 'src', 'deep')]) {
    const r = byId(await check({ home, env: { HOME: home, PATH }, cwd }), 'claude-code');
    assert.equal(fs.existsSync(marker), false, cwd + ': the plugin hook started the project node');
    assert.equal(r.state, 'protected', cwd + ': ' + r.problem);
  }
});

test('check: the plugin hook runs as Claude Code starts it: /bin/sh on zn-node.sh, or Git Bash given the line on Windows', (t) => {
  const root = tempDir(t, 'zn-check-run-root-');
  const ctx = { cwd: tempDir(t, 'zn-check-run-cwd-'), env: { PATH: '/usr/bin:/bin' } };
  const run = claudePluginRun(CLAUDE_PRE_COMMAND, root, ctx, 15, 'linux');
  assert.equal(run.file, '/bin/sh');
  assert.deepEqual(run.args, [root + '/scripts/zn-node.sh', 'PreToolUse', 'hook', 'claude-code']);
  assert.deepEqual(run.env, { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: ctx.cwd, PATH: '/usr/bin:/bin' });
  assert.equal(run.timeout, 15000);
  assert.equal(claudePluginRun(CLAUDE_PRE_COMMAND, root, ctx, 5, 'linux').timeout, 5000);
  assert.equal(claudePluginRun(CLAUDE_PRE_COMMAND, root, ctx, 600, 'linux').timeout, 15000);
  // Windows: Git Bash runs the line itself (CLAUDE_CODE_GIT_BASH_PATH, else next to git); none found, nothing runs.
  const bash = path.join(root, 'bash.exe');
  fs.writeFileSync(bash, '');
  const win = claudePluginRun(CLAUDE_PRE_COMMAND, root, { cwd: ctx.cwd, env: { PATH: '', CLAUDE_CODE_GIT_BASH_PATH: bash } }, 15, 'win32');
  assert.equal(win.file, bash);
  assert.deepEqual(win.args, ['-c', CLAUDE_PRE_COMMAND]);
  assert.equal(win.env.CLAUDE_PLUGIN_ROOT, root);
  assert.equal(claudePluginRun(CLAUDE_PRE_COMMAND, root, { cwd: ctx.cwd, env: { PATH: '' } }, 15, 'win32'), null);
});

// A zn-gate plugin for Cursor where Cursor keeps plugins added by hand (~/.cursor/plugins/local/<plugin>). Its hook
// files only leave a marker: zn-gate check must not run any of them.
function cursorPluginAt(home, { manifest, folder = 'zn-gate' } = {}) {
  const root = path.join(home, '.cursor', 'plugins', 'local', folder);
  const marker = path.join(home, 'cursor-plugin-ran.txt');
  fs.mkdirSync(path.join(root, '.cursor-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cursor'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  // The manifest the Cursor plugin shipped with up to 1.13.1 (the plugin is no longer offered, so it is not in the tree).
  const real = { name: 'zn-gate', version: '1.13.1', repository: 'https://github.com/usezn/zn', license: 'MIT',
    hooks: './cursor/hooks.json', mcpServers: './cursor/mcp.json' };
  fs.writeFileSync(path.join(root, '.cursor-plugin', 'plugin.json'), JSON.stringify(manifest || real));
  fs.writeFileSync(path.join(root, 'scripts', 'zn-launch.js'), "require('fs').appendFileSync(" + JSON.stringify(marker) + ", 'ran\\n');\n");
  fs.writeFileSync(path.join(root, 'cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { beforeReadFile: [{ command: 'node ./scripts/zn-launch.js hook cursor' }] } }));
  return { root, marker };
}

test('check: the zn-gate plugin for Cursor is found 7 levels down and through a link, and a link loop ends', { skip: process.platform === 'win32' }, async (t) => {
  const { cursorZnPlugin } = require('../lib/check')._internal;
  // The manifest the Cursor plugin shipped with up to 1.13.1 (the plugin is no longer offered, so it is not in the tree).
  const real = { name: 'zn-gate', version: '1.13.1', repository: 'https://github.com/usezn/zn', license: 'MIT',
    hooks: './cursor/hooks.json', mcpServers: './cursor/mcp.json' };
  const put = (dir) => {
    fs.mkdirSync(path.join(dir, '.cursor-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cursor-plugin', 'plugin.json'), JSON.stringify(real));
  };
  // Deep: ~/.cursor/plugins/a/b/c/d/e/f/zn-gate (7 levels below plugins).
  const deepHome = tempDir(t, 'zn-check-cursordeep-');
  const deep = path.join(deepHome, '.cursor', 'plugins', 'a', 'b', 'c', 'd', 'e', 'f', 'zn-gate');
  put(deep);
  assert.equal(cursorZnPlugin(deepHome), deep);
  // Through a link: ~/.cursor/plugins/cache -> a folder elsewhere that holds the plugin.
  const linkHome = tempDir(t, 'zn-check-cursorlink-');
  const elsewhere = tempDir(t, 'zn-check-cursorlink-real-');
  put(path.join(elsewhere, 'usezn', 'zn-gate'));
  fs.mkdirSync(path.join(linkHome, '.cursor', 'plugins'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(linkHome, '.cursor', 'plugins', 'cache'));
  assert.equal(cursorZnPlugin(linkHome), path.join(linkHome, '.cursor', 'plugins', 'cache', 'usezn', 'zn-gate'));
  // A link that loops back to its own folder: the walk ends, nothing is found.
  const loopHome = tempDir(t, 'zn-check-cursorloop-');
  fs.mkdirSync(path.join(loopHome, '.cursor', 'plugins', 'x'), { recursive: true });
  fs.symlinkSync(path.join(loopHome, '.cursor', 'plugins'), path.join(loopHome, '.cursor', 'plugins', 'x', 'back'));
  assert.equal(cursorZnPlugin(loopHome), null);
  // The check itself reports the linked plugin.
  const r = byId(await check({ home: linkHome, env: { HOME: linkHome, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: false }), 'cursor');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /no longer supports it/);
});

test('check: a zn-gate plugin for Cursor is NOT protected, also next to zn\'s Cursor hooks, and nothing of it runs', async (t) => {
  // The plugin alone.
  const home = tempDir(t, 'zn-check-cursorplug-');
  const { root, marker } = cursorPluginAt(home);
  for (const live of [true, false]) {
    const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live }), 'cursor');
    assert.equal(r.state, 'not-protected');
    assert.ok(!r.verified);
    assert.equal(r.where, root);
    assert.match(r.problem, /the zn-gate plugin for Cursor is installed \(.*\), and zn-gate no longer supports it: its hooks start `node` by name/);
    assert.match(r.fix, /`zn hooks install cursor` in your own terminal, then remove the zn-gate plugin in Cursor/);
  }
  // Next to zn's own Cursor hooks, which work: still not protected; the fix is to remove the plugin.
  const ctx = homeWithHooks(t, ['cursor']);
  const both = cursorPluginAt(ctx.home);
  let r = byId(await check(ctx), 'cursor');
  assert.equal(r.state, 'not-protected');
  assert.ok(!r.verified);
  assert.match(r.problem, /no longer supports it.*, while the zn hooks next to it \(.*hooks\.json\) work$/);
  assert.match(r.fix, /^remove the zn-gate plugin in Cursor/);
  // Next to hooks that do not work: repair the hooks first, then remove the plugin.
  const file = getAdapter('cursor').hooksFile(ctx);
  const tree = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete tree.hooks.beforeReadFile;
  fs.writeFileSync(file, JSON.stringify(tree));
  r = byId(await check(ctx), 'cursor');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /and the zn hooks next to it do not work either \(/);
  assert.match(r.fix, /^first repair the hooks: run `zn hooks install cursor`.*; after that, remove the zn-gate plugin in Cursor/);
  assert.equal(fs.existsSync(marker), false, 'zn-gate check ran the Cursor plugin');
  assert.equal(fs.existsSync(both.marker), false, 'zn-gate check ran the Cursor plugin');
});

test('check: no Cursor plugin, or another plugin in Cursor\'s plugin folder, leaves the Cursor result as it was', async (t) => {
  const ctx = homeWithHooks(t, ['cursor']);
  let r = byId(await check(ctx), 'cursor');
  assert.equal(r.state, 'protected', r.problem);
  assert.equal(r.verified, true);
  const others = [
    { name: 'other-plugin', repository: 'https://github.com/usezn/zn' },
    { name: 'zn-gate', repository: 'https://github.com/example/zn-gate', homepage: 'https://example.com/usezn/zn' },
  ];
  for (const manifest of others) {
    const { marker } = cursorPluginAt(ctx.home, { manifest, folder: manifest.name + '-x' });
    r = byId(await check(ctx), 'cursor');
    assert.equal(r.state, 'protected', JSON.stringify(manifest) + ': ' + r.problem);
    assert.equal(fs.existsSync(marker), false);
  }
  // Nothing set up and only another plugin there: still not set up.
  const home = tempDir(t, 'zn-check-cursorother-');
  cursorPluginAt(home, { manifest: others[0] });
  r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-') }), 'cursor');
  assert.equal(r.state, 'not-set-up');
});

test('check never starts a node from the project, node_modules or a link into them, also with no plugin (node version probe)', { skip: process.platform === 'win32' }, async (t) => {
  const { resolveHookNode } = require('../lib/check')._internal;
  const project = tempDir(t, 'zn-check-probe-proj-');
  fs.mkdirSync(path.join(project, '.git'));
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  const marker = path.join(tempDir(t, 'zn-check-probe-mark-'), 'ran.txt');
  const fake = '#!/bin/sh\necho "$1" >> ' + JSON.stringify(marker) + '\n[ "$1" = --version ] && echo v99.0.0\nexit 0\n';
  const put = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'node'), fake, { mode: 0o755 }); return dir; };
  const projBin = put(path.join(project, 'bin'));
  const nmBin = put(path.join(tempDir(t, 'zn-check-probe-nm-'), 'node_modules', '.bin'));
  // A folder outside the project whose node is a link to the project's node.
  const linkDir = tempDir(t, 'zn-check-probe-link-');
  fs.symlinkSync(path.join(projBin, 'node'), path.join(linkDir, 'node'));
  const nodeDir = path.dirname(process.execPath);
  const PATH = [projBin, nmBin, linkDir, nodeDir, process.env.PATH || ''].join(path.delimiter);
  for (const cwd of [project, path.join(project, 'src')]) {
    const hook = resolveHookNode({ PATH }, cwd);
    assert.ok(hook && hook.version === process.versions.node, cwd + ': ' + JSON.stringify(hook));
    assert.ok(!hook.path.startsWith(project) && !hook.path.startsWith(linkDir), hook.path);
  }
  // Only untrusted nodes on the PATH: the version is unknown, nothing runs.
  assert.equal(resolveHookNode({ PATH: [projBin, nmBin, linkDir].join(path.delimiter) }, project), null);
  // The whole check with no plugin installed (the warnings path) and with the plugin: the project node never runs.
  const home = tempDir(t, 'zn-check-probe-home-');
  await check({ home, env: { HOME: home, PATH }, cwd: path.join(project, 'src') });
  await check({ home, env: { HOME: home, PATH }, cwd: path.join(project, 'src'), live: false });
  fakePlugin(home, launcher());
  await check({ home, env: { HOME: home, PATH }, cwd: project });
  assert.equal(fs.existsSync(marker), false, 'zn-gate check started a node from the project, node_modules or a link into them');
});

test('check: from the home folder, or a dotfiles home with git, a Node.js only in nvm or volta counts', { skip: process.platform === 'win32' }, (t) => {
  const { resolveHookNode } = require('../lib/check')._internal;
  for (const [tool, dir] of [['nvm', path.join('.nvm', 'versions', 'node', 'v22.0.0', 'bin')], ['volta', path.join('.volta', 'bin')]]) {
    for (const dotfiles of [false, true]) {
      const home = tempDir(t, 'zn-check-homenode-');
      if (dotfiles) fs.mkdirSync(path.join(home, '.git'));
      const bin = path.join(home, dir);
      fs.mkdirSync(bin, { recursive: true });
      fs.symlinkSync(process.execPath, path.join(bin, 'node'));
      // Only that folder on the PATH: no system node to fall back on.
      const env = { HOME: home, PATH: bin };
      const proj = path.join(home, 'notes');
      fs.mkdirSync(proj);
      for (const cwd of [home, proj]) {
        const hook = resolveHookNode(env, cwd);
        assert.ok(hook && hook.version === process.versions.node, tool + (dotfiles ? ' dotfiles' : '') + ' from ' + cwd + ': ' + JSON.stringify(hook));
      }
    }
  }
});
