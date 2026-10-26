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

function fakePlugin(home, launcherSource, settings) {
  const root = path.join(home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate', '1.8.1');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'zn-launch.js'), launcherSource);
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'zn-gate@usezn': [{ scope: 'user', installPath: root }] } }));
  if (settings) fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  return root;
}

// A stand-in for the plugin launcher that hands the event to the real runner (as the real launcher does after
// verifying the pinned package), or fails closed on every event when `broken`.
function launcher({ broken = false, systemMessage = '' } = {}) {
  return "const [mode] = process.argv.slice(2);\n" +
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

test('check: a Claude Code plugin whose hooks.json starts a hook with a program by name is not protected', async (t) => {
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
  // The shell by its full path, with the plugin root in quotes: the plugin is checked as before (POSIX: on Windows
  // the hook also needs "shell": "bash").
  if (process.platform === 'win32') return;
  const home = tempDir(t, 'zn-check-ccabs-');
  const root = fakePlugin(home, launcher());
  nodeSh(root);
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), hooksJson('/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse hook claude-code'));
  const ok = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
  assert.equal(ok.state, 'protected', ok.problem);
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
  // The forms zn's plugins use (also with shell syntax inside quotes) are checked as before.
  const safe = ['/bin/sh ' + S, '/bin/bash ' + S, '/bin/sh "${CLAUDE_PLUGIN_ROOT}/a;b|c.sh" PreToolUse hook claude-code "x && y"'];
  if (process.platform !== 'win32') {
    for (const cmd of safe) {
      const home = tempDir(t, 'zn-check-ccb3ok-');
      const root = fakePlugin(home, launcher());
      nodeSh(root);
      fs.writeFileSync(path.join(root, 'a;b|c.sh'), fs.readFileSync(path.join(root, 'scripts', 'zn-node.sh')), { mode: 0o755 });
      fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), hooksJson(cmd));
      const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
      assert.equal(r.state, 'protected', cmd + ': ' + r.problem);
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

// A stand-in for the plugin's scripts/zn-node.sh: runs the launcher with this Node.js by its full path, as the real
// wrapper does once it found Node.js. `mark` (a file) records that it ran, with the shell and the folder it ran in.
function nodeSh(root, { mark = null, body = null } = {}) {
  const run = body !== null ? body
    : 'exec ' + JSON.stringify(process.execPath) + ' "$CLAUDE_PLUGIN_ROOT/scripts/zn-launch.js" "$2" "$3"\n';
  const rec = mark ? 'printf "%s|%s|%s\\n" "${BASH_VERSION:-sh}" "$PWD" "$CLAUDE_PLUGIN_ROOT" >> ' + JSON.stringify(mark) + '\n' : '';
  fs.writeFileSync(path.join(root, 'scripts', 'zn-node.sh'), '#!/bin/sh\n' + rec + run, { mode: 0o755 });
}

test('check runs the Claude Code plugin hook as Claude Code starts it: the manifest line through the shell, the project as folder', { skip: process.platform === 'win32' }, async (t) => {
  const line = (ev) => '/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" ' + ev + ' hook claude-code';
  const manifest = (shell) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '^(Read|Bash)$', hooks: [Object.assign({ type: 'command', command: line('PreToolUse'), onFailure: 'block' }, shell ? { shell } : {})] }] } });
  for (const shell of [null, 'bash']) {
    const home = tempDir(t, 'zn-check-host-');
    const root = fakePlugin(home, launcher());
    const mark = path.join(tempDir(t, 'zn-check-host-mark-'), 'ran.txt');
    nodeSh(root, { mark });
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), manifest(shell));
    const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
    assert.equal(r.state, 'protected', String(shell) + ': ' + r.problem);
    const runs = fs.readFileSync(mark, 'utf8').trim().split('\n').map((l) => l.split('|'));
    assert.ok(runs.length >= 2, 'the wrapper ran for the .env read and the ordinary file');
    for (const [, pwd, pr] of runs) {
      assert.equal(pr, root, 'CLAUDE_PLUGIN_ROOT is the plugin folder');
      assert.ok(pwd && pwd !== root && !pwd.startsWith(root + path.sep), 'run from the project, not from the plugin folder: ' + pwd);
    }
  }
});

test('check: a plugin whose zn-node.sh does not reach zn is not protected, although its launcher works (the wrapper is checked too)', { skip: process.platform === 'win32' }, async (t) => {
  for (const body of ['exit 0\n', 'exit 2\n', 'echo "{}"\n']) {
    const home = tempDir(t, 'zn-check-wrap-');
    const root = fakePlugin(home, launcher());
    nodeSh(root, { body });
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse hook claude-code', onFailure: 'block' }] }] } }));
    const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
    assert.equal(r.state, 'not-protected', JSON.stringify(body));
    assert.match(r.problem, body === 'exit 2\n' ? /blocks everything/ : /did not block the read of \.env/, JSON.stringify(body));
  }
});

test('check: a plugin without hooks/hooks.json keeps the launcher check (no manifest line to run)', async (t) => {
  const home = tempDir(t, 'zn-check-nomanifest-');
  fakePlugin(home, launcher());
  const r = byId(await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
  assert.equal(r.state, 'protected', r.problem);
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

test('check: a plugin hook that asks for bash where there is no bash is not protected, with the fix, and nothing runs', { skip: process.platform === 'win32' }, async (t) => {
  const home = tempDir(t, 'zn-check-nobash-');
  const root = fakePlugin(home, launcher());
  const mark = path.join(tempDir(t, 'zn-check-nobash-mark-'), 'ran.txt');
  nodeSh(root, { mark });
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [
    { type: 'command', shell: 'bash', command: '/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse hook claude-code', onFailure: 'block' }] }] } }));
  // A PATH with Node.js only (a link to it in an empty folder): no bash in any absolute entry.
  const PATH = tempDir(t, 'zn-check-nobash-path-');
  fs.symlinkSync(process.execPath, path.join(PATH, 'node'));
  const r = byId(await check({ home, env: { HOME: home, PATH }, cwd: tempDir(t, 'zn-check-cwd-'), live: true }), 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /runs the hooks of the zn-gate plugin with bash, and no bash was found/);
  assert.match(r.fix, /zn hooks install claude-code/);
  assert.equal(fs.existsSync(mark), false, 'the wrapper ran without a shell');
});

test('gitBash with gitOnly never falls back to a bash or sh on the PATH', (t) => {
  const { gitBash } = require('../lib/check')._internal;
  const dir = tempDir(t, 'zn-check-gitbash-');
  for (const n of ['bash', 'sh']) fs.writeFileSync(path.join(dir, n), '#!/bin/sh\n', { mode: 0o755 });
  const env = { PATH: dir };
  assert.equal(gitBash(env, { gitOnly: true }), null);
  assert.ok(gitBash(env), 'without gitOnly the PATH fallback stays (other callers)');
});
