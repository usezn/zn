'use strict';

process.env.ZN_STATS = 'off';

// zn-gate and the ZCode plugin: how install and check see it. ZCode records an installed plugin in
// ~/.zcode/cli/plugins/installed_plugins.json and its switch in ~/.zcode/cli/config.json (plugins.enabledPlugins);
// the plugin's hooks run whatever hooks.enabled says (measured on the ZCode desktop app 3.16.3, see bench/e2e/zcode-plugin).
// These tests use a stub plugin folder; the real plugin runs in plugins/tools/test-zcode-plugin.js and the e2e.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { getAdapter } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const zc = getAdapter('zcode');
const posix = process.platform !== 'win32';
// The plugin's hooks.json has two entries per event, each started by its full path (so no planted program can run): /bin/sh on
// a script (macOS, Linux) and the system PowerShell on an inline command that runs scripts/zn-hook.ps1 (Windows). Only the entry of the
// system the tests run on can start, so HI is its position in a hooks group.
const HI = posix ? 0 : 1;
const SYSPATH = posix ? '/usr/bin:/bin' : (process.env.SystemRoot || 'C:\\Windows') + '\\System32';
const ID = 'zn-gate@usezn';
// The plugin's real manifest in this repository.
const REPO_HOOKS = path.join(__dirname, '..', '..', '..', 'plugins', 'zcode', 'hooks', 'hooks.json');

const base = (home) => path.join(home, '.zcode', 'cli');
const cfgFile = (home) => path.join(base(home), 'config.json');
const writeCfg = (home, obj) => {
  fs.mkdirSync(base(home), { recursive: true });
  fs.writeFileSync(cfgFile(home), JSON.stringify(obj, null, 2));
};
const readCfg = (home) => JSON.parse(fs.readFileSync(cfgFile(home), 'utf8'));

// A plugin folder as ZCode leaves it in its cache. The stub hook denies a request that names ".env" and allows any other.
function installPlugin(home, { script = true, manifest = true, id = ID, hooks = (h) => h } = {}) {
  const root = path.join(base(home), 'plugins', 'cache', 'usezn', 'zn-gate', '1.14.0');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, '.zcode-plugin'), { recursive: true });
  if (manifest) fs.writeFileSync(path.join(root, '.zcode-plugin', 'plugin.json'), '{"name":"zn-gate","version":"1.14.0"}');
  if (hooks) {
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), hooks(fs.readFileSync(REPO_HOOKS, 'utf8')));
  }
  if (script) {
    fs.writeFileSync(path.join(root, 'scripts', 'zn-hook.sh'),
      '#!/bin/sh\ninput=$(cat)\ncase "$input" in *.env*) printf \'%s\' \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"zn: .env holds plain-text secrets."}}\' ;; esac\nexit 0\n',
      { mode: 0o755 });
  }
  if (script) {
    // The Windows counterpart of the stub above: PowerShell reads it from the plugin folder and runs it as a script block.
    fs.writeFileSync(path.join(root, 'scripts', 'zn-hook.ps1'),
      "$in = [Console]::In.ReadToEnd()\nif ($in -match '\\.env') { [Console]::Out.Write('{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"zn: .env holds plain-text secrets.\"}}') }\nexit 0\n");
  }
  fs.writeFileSync(path.join(base(home), 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 1, plugins: [{ id, name: 'zn-gate', marketplace: 'usezn', version: '1.14.0', installPath: root, scope: 'user', source: './zn-gate' }],
  }));
  return root;
}

test('pluginState: absent, installed and on, switched off, plugins off, not ours', (t) => {
  const home = tempDir(t, 'zn-zcp-state-');
  assert.deepEqual(zc.pluginState({ home }), { root: null, id: null, version: null, enabled: false, pluginsOff: false, listed: false });

  const root = installPlugin(home);
  writeCfg(home, { plugins: { enabledPlugins: { [ID]: true } } });
  let s = zc.pluginState({ home });
  assert.equal(s.root, root);
  assert.equal(s.id, ID);
  assert.equal(s.version, '1.14.0');
  assert.equal(s.enabled, true);

  // No entry at all: ZCode writes true on install, so an absent entry is taken as on.
  writeCfg(home, {});
  assert.equal(zc.pluginState({ home }).enabled, true);
  fs.rmSync(cfgFile(home));
  assert.equal(zc.pluginState({ home }).enabled, true);

  writeCfg(home, { plugins: { enabledPlugins: { [ID]: false } } });
  s = zc.pluginState({ home });
  assert.equal(s.enabled, false);
  assert.equal(s.listed, true);

  writeCfg(home, { plugins: { enabled: false, enabledPlugins: { [ID]: true } } });
  s = zc.pluginState({ home });
  assert.equal(s.pluginsOff, true);
  assert.equal(s.enabled, false);

  // A plugin of another name, or a zn-gate folder without our files, is not ours.
  const other = tempDir(t, 'zn-zcp-state2-');
  installPlugin(other, { id: 'other@usezn' });
  assert.equal(zc.pluginState({ home: other }).root, null);
  const noScript = tempDir(t, 'zn-zcp-state3-');
  installPlugin(noScript, { script: false });
  assert.equal(zc.pluginState({ home: noScript }).root, null);
  const broken = tempDir(t, 'zn-zcp-state4-');
  fs.mkdirSync(path.join(base(broken), 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(base(broken), 'plugins', 'installed_plugins.json'), '{ nope');
  assert.equal(zc.pluginState({ home: broken }).root, null);
});

test('zn-gate check: the plugin alone protects ZCode, with hooks.enabled false, not set or true', async (t) => {
  const check = require('../lib/check');
  const home = tempDir(t, 'zn-zcp-only-');
  const cwd = tempDir(t, 'zn-zcp-only-cwd-');
  const env = { ...process.env, HOME: home };
  const find = async (live) => (await check.check({ home, cwd, env, live })).results.find((r) => r.id === 'zcode');
  installPlugin(home);
  for (const hooks of [{ enabled: false }, undefined, { enabled: true }]) {
    writeCfg(home, { plugins: { enabledPlugins: { [ID]: true } }, ...(hooks ? { hooks } : {}) });
    const r = await find(true);
    assert.equal(r.state, 'protected', JSON.stringify(hooks) + ' ' + r.problem);
    assert.equal(r.via, 'plugin');
    assert.equal(r.verified, true);
    assert.equal(r.where, 'the zn-gate plugin');
  }
  // Without live checks only the setup is read.
  assert.notEqual((await find(false)).state, 'not-set-up');
});

test('zn-gate check: a plugin that is turned off, with nothing else of zn running, is NOT protected', async (t) => {
  const check = require('../lib/check');
  const home = tempDir(t, 'zn-zcp-off-');
  const cwd = tempDir(t, 'zn-zcp-off-cwd-');
  const env = { ...process.env, HOME: home };
  const find = async () => (await check.check({ home, cwd, env, live: true })).results.find((r) => r.id === 'zcode');
  installPlugin(home);
  writeCfg(home, { hooks: { enabled: false }, plugins: { enabledPlugins: { [ID]: false } } });
  let r = await find();
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /plugin is turned off in ZCode/);
  assert.match(r.fix, /Settings, Plugins|hooks install zcode/);

  writeCfg(home, { plugins: { enabled: false, enabledPlugins: { [ID]: true } } });
  r = await find();
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /plugins are turned off in ZCode/);
});

test('zn-gate check: plugin and zn hooks both on is protected, with a note about the double run', async (t) => {
  const check = require('../lib/check');
  const home = tempDir(t, 'zn-zcp-both-');
  const cwd = tempDir(t, 'zn-zcp-both-cwd-');
  const env = { ...process.env, HOME: home };
  zc.install({ home, nodePath: process.execPath });
  installPlugin(home);
  const c = readCfg(home);
  writeCfg(home, { ...c, plugins: { enabledPlugins: { [ID]: true } } });
  const r = (await check.check({ home, cwd, env, live: true })).results.find((x) => x.id === 'zcode');
  assert.equal(r.state, 'protected', r.problem);
  assert.ok(r.notes.some((n) => /checked twice/.test(n) && /hooks uninstall zcode/.test(n)), JSON.stringify(r.notes));
});

test('zn-gate check: plugin off with zn hooks on is protected by the hooks (and hooks.enabled false is still reported)', async (t) => {
  const check = require('../lib/check');
  const home = tempDir(t, 'zn-zcp-hk-');
  const cwd = tempDir(t, 'zn-zcp-hk-cwd-');
  const env = { ...process.env, HOME: home };
  zc.install({ home, nodePath: process.execPath });
  installPlugin(home);
  const c = readCfg(home);
  writeCfg(home, { ...c, plugins: { enabledPlugins: { [ID]: false } } });
  const find = async () => (await check.check({ home, cwd, env, live: true })).results.find((x) => x.id === 'zcode');
  let r = await find();
  assert.equal(r.state, 'protected', r.problem);
  assert.ok(r.notes.some((n) => /plugin is installed but turned off/.test(n)), JSON.stringify(r.notes));
  // The hooks switch off as well: nothing runs.
  writeCfg(home, { ...c, hooks: { ...c.hooks, enabled: false }, plugins: { enabledPlugins: { [ID]: false } } });
  r = await find();
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /"hooks\.enabled" is false/);
});

test('zn hooks install zcode warns when the plugin is installed and on, and not when it is off', (t) => {
  const home = tempDir(t, 'zn-zcp-inst-');
  installPlugin(home);
  writeCfg(home, { plugins: { enabledPlugins: { [ID]: true } } });
  let rep = zc.install({ home, nodePath: process.execPath });
  assert.ok(rep.warnings.some((w) => /also installed and turned on/.test(w) && /checked twice/.test(w)), rep.warnings.join('\n'));
  assert.ok(rep.warnings.some((w) => /zn hooks uninstall zcode/.test(w)));
  zc.uninstall({ home });

  writeCfg(home, { plugins: { enabledPlugins: { [ID]: false } } });
  rep = zc.install({ home, nodePath: process.execPath });
  assert.ok(!rep.warnings.some((w) => /also installed/.test(w)));
  // Nothing installed at all: no warning either.
  const clean = tempDir(t, 'zn-zcp-inst2-');
  rep = zc.install({ home: clean, nodePath: process.execPath });
  assert.ok(!rep.warnings.some((w) => /also installed/.test(w)));
});

// Programs planted where a relative or empty PATH entry, or the folder the agent runs in, would find them. Each one
// only leaves a marker file and exits 0 (an "allow"), as a counterfeit interpreter that skips zn would.
function plantPrograms(t) {
  const cwd = tempDir(t, 'zn-zcp-plant-');
  const marker = path.join(cwd, 'planted-ran');
  for (const d of [cwd, path.join(cwd, 'zbin')]) {
    fs.mkdirSync(d, { recursive: true });
    for (const name of ['sh', 'node']) {
      fs.writeFileSync(path.join(d, name), '#!/bin/sh\necho ' + name + ' >> ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
    }
  }
  return { cwd, marker };
}
const PLANTED_PATHS = posix ? ['.:/usr/bin:/bin', 'zbin:/usr/bin:/bin', ':/usr/bin:/bin'] : ['.;' + SYSPATH, 'zbin;' + SYSPATH, ';' + SYSPATH];

async function zcodeCheck(home, cwd, PATH) {
  const check = require('../lib/check');
  return (await check.check({ home, cwd, env: { ...process.env, HOME: home, PATH }, live: true })).results.find((x) => x.id === 'zcode');
}

test('the ZCode plugin manifest starts every hook (sh and PowerShell) by its full path', () => {
  const hooks = JSON.parse(fs.readFileSync(REPO_HOOKS, 'utf8')).hooks;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of groups) for (const h of g.hooks) {
      assert.equal(h.type, 'process', event);
      assert.ok(path.posix.isAbsolute(h.command) || /^[A-Za-z]:\//.test(h.command), event + ' starts ' + h.command + ' by name');
    }
  }
});

test('zn-gate check runs the plugin hook as ZCode starts it (the program named in hooks.json), never a planted one', async (t) => {
  const old = process.cwd();
  t.after(() => process.chdir(old));
  const home = tempDir(t, 'zn-zcp-sh-');
  const { cwd, marker } = plantPrograms(t);
  installPlugin(home);
  writeCfg(home, { plugins: { enabledPlugins: { [ID]: true } } });
  process.chdir(cwd);
  for (const PATH of PLANTED_PATHS) {
    const r = await zcodeCheck(home, cwd, PATH);
    assert.equal(fs.existsSync(marker), false, PATH + ': a planted program ran');
    assert.equal(r.state, 'protected', PATH + ' ' + r.problem);
    assert.equal(r.verified, true, PATH);
  }
});

test('zn-gate check: a plugin manifest that starts its hook by name is NOT protected, whatever the PATH', async (t) => {
  const old = process.cwd();
  t.after(() => process.chdir(old));
  const home = tempDir(t, 'zn-zcp-bare-');
  const { cwd, marker } = plantPrograms(t);
  // The manifest of the 1.14.0 release candidates: `sh` by name.
  installPlugin(home, { hooks: (h) => h.split('"command": "/bin/sh"').join('"command": "sh"') });
  writeCfg(home, { plugins: { enabledPlugins: { [ID]: true } } });
  process.chdir(cwd);
  for (const PATH of [...PLANTED_PATHS, SYSPATH]) {
    const r = await zcodeCheck(home, cwd, PATH);
    assert.equal(fs.existsSync(marker), false, PATH + ': a planted program ran');
    assert.equal(r.state, 'not-protected', PATH);
    assert.match(r.problem, /starts its \w+ hook with `sh` by name/, PATH);
    assert.match(r.fix, /install the zn-gate plugin again in ZCode/, PATH);
  }
});

test('zn-gate check: a manifest whose program is not on this computer, or with no PreToolUse hook, is NOT protected', async (t) => {
  const home = tempDir(t, 'zn-zcp-gone-');
  const cwd = tempDir(t, 'zn-zcp-gone-cwd-');
  installPlugin(home, { hooks: (h) => h.split('"command": "/bin/sh"').join('"command": "/nonexistent/zn-test/sh"') });
  writeCfg(home, { plugins: { enabledPlugins: { [ID]: true } } });
  let r = await zcodeCheck(home, cwd, SYSPATH);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /`\/nonexistent\/zn-test\/sh .*`, which is not a system shell running a script inside the plugin folder/);
  const home2 = tempDir(t, 'zn-zcp-nopre-');
  installPlugin(home2, { hooks: (h) => { const j = JSON.parse(h); delete j.hooks.PreToolUse; return JSON.stringify(j); } });
  writeCfg(home2, { plugins: { enabledPlugins: { [ID]: true } } });
  r = await zcodeCheck(home2, cwd, SYSPATH);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /has no PreToolUse hook/);
  const home3 = tempDir(t, 'zn-zcp-nofile-');
  installPlugin(home3, { hooks: null });
  writeCfg(home3, { plugins: { enabledPlugins: { [ID]: true } } });
  r = await zcodeCheck(home3, cwd, SYSPATH);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /has no PreToolUse hook/);
});

// The same manifest edits judged as on Windows, whatever system runs the tests: an entry that starts with "/" and is not the
// safe /bin/sh form is not skipped because the Windows entry is fine.
test('zn-gate check: on Windows, a changed /bin/sh entry is judged too, not hidden behind the PowerShell entry', async (t) => {
  const check = require('../lib/check');
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  const cwd = tempDir(t, 'zn-zcp-w32-cwd-');
  const run = async (hooks) => {
    const home = tempDir(t, 'zn-zcp-w32-');
    installPlugin(home, { hooks });
    writeCfg(home, { plugins: { enabledPlugins: { [ID]: true } } });
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try { return (await check.check({ home, cwd, env: { ...process.env, HOME: home, PATH: SYSPATH }, live: false })).results.find((r) => r.id === 'zcode'); } finally { Object.defineProperty(process, 'platform', real); }
  };
  let r = await run((h) => h.split('"command": "/bin/sh"').join('"command": "/nonexistent/zn-test/sh"'));
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /not a system shell running a script inside the plugin folder/);
  r = await run((h) => { const j = JSON.parse(h); for (const g of Object.values(j.hooks)) for (const e of g) for (const x of e.hooks) { x.args = ['sh', ...x.args]; x.command = '/usr/bin/env'; } return JSON.stringify(j); });
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /`env`, which looks the program/);
  r = await run((h) => { const j = JSON.parse(h); delete j.hooks.PreToolUse; return JSON.stringify(j); });
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /has no PreToolUse hook/);
});

// The reproduction of the 1.14.0 review: with a relative or empty PATH entry, the host's own lookup of the first
// program in the manifest picked a planted `sh`, and a shell picked a planted `node`. The real plugin manifest and
// script, started the way ZCode starts a process hook (no shell, the project as working folder), run nothing planted.
test('the ZCode plugin hook, started as ZCode starts it, runs no planted sh or node (relative or empty PATH entry)', (t) => {
  const { spawnSync } = require('child_process');
  const pluginRoot = path.join(__dirname, '..', '..', '..', 'plugins', 'zcode');
  const pre = JSON.parse(fs.readFileSync(REPO_HOOKS, 'utf8')).hooks.PreToolUse[0].hooks[HI];
  const args = pre.args.map((a) => a.split('${ZCODE_PLUGIN_ROOT}').join(pluginRoot));
  const { cwd, marker } = plantPrograms(t);
  const event = JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, '.env') } });
  const paths = posix ? ['.:/usr/bin:/bin', ':/usr/bin:/bin'] : ['.;' + SYSPATH, ';' + SYSPATH];
  for (const PATH of paths) {
    // ZCode gives the hook the plugin folder in ZCODE_PLUGIN_ROOT (the Windows entry reads its script there).
    const env = posix ? { PATH, HOME: cwd } : { PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: cwd, ZCODE_PLUGIN_ROOT: pluginRoot };
    const r = spawnSync(pre.command, args, { cwd, input: event, encoding: 'utf8', env, timeout: 40000, windowsHide: true });
    assert.equal(r.error, undefined, PATH + ': ' + (r.error && r.error.message));
    assert.equal(fs.existsSync(marker), false, PATH + ': planted ' + (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '') + ' ran');
    // This checkout has no verified zn-gate copy inside the plugin folder, so the hook refuses (exit 2), as it must:
    // never the planted program's exit 0.
    assert.equal(r.status, 2, PATH + ': ' + r.stderr);
  }
  if (!posix) return;
  // Before the fix: the same lookup by name picks the planted shell (what the review measured).
  const before = spawnSync('sh', args, { cwd, input: event, encoding: 'utf8', env: { PATH: '.:/usr/bin:/bin', HOME: cwd } });
  assert.equal(before.status, 0);
  assert.match(fs.readFileSync(marker, 'utf8'), /^sh$/m, 'the lookup by name did not pick the planted sh');
});

test('zn-gate check: a ZCode process hook counts only as an absolute sh or node on a script inside the plugin folder', async (t) => {
  const cwd = tempDir(t, 'zn-zcp-wl-cwd-');
  const swap = (cmd, args) => (h) => {
    const j = JSON.parse(h);
    for (const groups of Object.values(j.hooks)) for (const g of groups) for (const x of g.hooks) { x.command = cmd; x.args = args(x.args); }
    return JSON.stringify(j);
  };
  const cases = [
    [swap('/usr/bin/env', (a) => ['sh', ...a]), /`env`, which looks the program/],
    [swap('/bin/sh', (a) => ['-c', 'sh ' + a.join(' ')]), /code given inline \(`sh -c`\)/],
    [swap('/bin/sh', (a) => ['-o', 'errexit', '-c', 'sh ' + a.join(' ')]), /code given inline \(`sh -c`\)/],
    [swap('/usr/bin/nohup', (a) => ['sh', ...a]), /not a system shell running a script inside the plugin folder/],
    [swap('/bin/sh', (a) => ['scripts/zn-hook.sh', a[1]]), /not a system shell running a script inside the plugin folder/],
    [swap('/bin/sh', (a) => ['./scripts/zn-hook.sh', a[1]]), /not a system shell running a script inside the plugin folder/],
    [swap('/bin/sh', () => ['-s']), /not a system shell running a script inside the plugin folder/],
    [swap('/bin/sh', () => []), /not a system shell running a script inside the plugin folder/],
  ];
  for (const [hooks, re] of cases) {
    const home = tempDir(t, 'zn-zcp-wl-');
    installPlugin(home, { hooks });
    writeCfg(home, { plugins: { enabledPlugins: { [ID]: true } } });
    const r = await zcodeCheck(home, cwd, SYSPATH);
    assert.equal(r.state, 'not-protected', String(re));
    assert.match(r.problem, re);
  }
});

test('zn-gate check: a ZCode hook with a non-system sh, a pattern, or a script linked out of the plugin is NOT protected and does not run', async (t) => {
  const project = tempDir(t, 'zn-zcp-strict-proj-');
  const marker = path.join(project, 'ran.txt');
  const planted = '#!/bin/sh\necho ran >> ' + JSON.stringify(marker) + '\nexit 0\n';
  fs.writeFileSync(path.join(project, 'sh'), planted, { mode: 0o755 });
  fs.writeFileSync(path.join(project, 'evil.sh'), planted, { mode: 0o755 });
  const swapCmd = (cmd) => (h) => h.split('"command": "/bin/sh"').join('"command": ' + JSON.stringify(cmd));
  const cases = [
    [swapCmd(path.join(project, 'sh')), null, /not a system shell running a script inside the plugin folder/],
    [swapCmd('/*/sh'), null, /a pattern the shell or the host expands/],
    [(h) => h.split('scripts/zn-hook.sh').join('scripts/link.sh'), 'link', /not a file inside the plugin folder/],
  ];
  for (const [hooks, kind, re] of cases) {
    const home = tempDir(t, 'zn-zcp-strict-');
    const root = installPlugin(home, { hooks });
    if (kind === 'link') {
      // Creating a link on Windows needs a privilege a standard user does not have: that case is then not run.
      try { fs.symlinkSync(path.join(project, 'evil.sh'), path.join(root, 'scripts', 'link.sh')); } catch (err) { if (err.code === 'EPERM' && !posix) continue; throw err; }
    }
    writeCfg(home, { plugins: { enabledPlugins: { [ID]: true } } });
    const r = await zcodeCheck(home, project, SYSPATH);
    assert.equal(r.state, 'not-protected', String(re));
    assert.match(r.problem, re);
  }
  assert.equal(fs.existsSync(marker), false, 'a program or script named by a refused manifest ran');
});

test('zn-gate check: only the PreToolUse hook the ZCode plugin ships counts; a decoy script in the plugin is NOT protected and does not run', async (t) => {
  const cwd = tempDir(t, 'zn-zcp-decoy-cwd-');
  const marker = path.join(cwd, 'noop-ran.txt');
  const preArgs = (args) => (h) => {
    const j = JSON.parse(h);
    j.hooks.PreToolUse[0].hooks[HI].args = args;
    return JSON.stringify(j);
  };
  const cases = [
    preArgs(['${ZCODE_PLUGIN_ROOT}/scripts/noop.sh', 'PreToolUse']),
    preArgs(['${ZCODE_PLUGIN_ROOT}/scripts/zn-hook.sh', 'PostToolUse']),
    preArgs(['${ZCODE_PLUGIN_ROOT}/scripts/zn-hook.sh', 'PreToolUse', '--extra']),
    (h) => { const j = JSON.parse(h); j.hooks.PreToolUse[0].hooks[HI].command = '/bin/bash'; return JSON.stringify(j); },
    (h) => { const j = JSON.parse(h); j.hooks.PreToolUse[0].matcher = 'Bash'; return JSON.stringify(j); },
  ];
  for (const hooks of cases) {
    for (const live of [true, false]) {
      const home = tempDir(t, 'zn-zcp-decoy-');
      const root = installPlugin(home, { hooks });
      fs.writeFileSync(path.join(root, 'scripts', 'noop.sh'), '#!/bin/sh\necho ran >> ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
      writeCfg(home, { plugins: { enabledPlugins: { [ID]: true } } });
      const check = require('../lib/check');
      const r = (await check.check({ home, cwd, env: { ...process.env, HOME: home, PATH: SYSPATH }, live })).results.find((x) => x.id === 'zcode');
      assert.equal(r.state, 'not-protected', hooks.toString());
      assert.ok(!r.verified);
      // On Windows a changed PowerShell entry is read as a program the plugin does not ship, and the one case that only changes the matcher as a hook that is not the shipped one.
      assert.match(r.problem, posix ? /is not the hook the plugin ships \(`\/bin\/sh \$\{ZCODE_PLUGIN_ROOT\}\/scripts\/zn-hook\.sh PreToolUse`/ : /is not the Windows hook the plugin ships|is not the hook the plugin ships \(`powershell\.exe|a pattern the shell or the host expands/);
      assert.match(r.fix, /install the zn-gate plugin again in ZCode/);
    }
  }
  assert.equal(fs.existsSync(marker), false, 'zn-gate check ran the decoy script');
});

// The real two-entry hooks.json (a /bin/sh hook and a PowerShell hook for every event): each system judges only the entry that can start on it.
test('zn-gate check reads the two-entry manifest for the system it runs on: both systems find it protected, a changed entry of that system is not', async (t) => {
  const { _internal } = require('../lib/check');
  const home = tempDir(t, 'zn-zcp-two-');
  const root = installPlugin(home);
  const read = (hooks) => {
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), hooks);
    return _internal.pluginManifest(root, 'ZCODE_PLUGIN_ROOT');
  };
  const real = fs.readFileSync(REPO_HOOKS, 'utf8');
  for (const win of [false, true]) {
    const m = _internal.zcodeRelevant(read(real), win);
    assert.equal(m.bare, null, 'win=' + win + ': ' + (m.bare && m.bare.byName));
    const pre = m.hooks.filter((h) => h.event === 'PreToolUse' && !h.byName);
    assert.equal(pre.length, 1, 'win=' + win);
    assert.equal(pre[0].win, win);
    assert.equal(m.hooks.length, 4, 'one hook per event for this system');
  }
  // A changed entry is judged on its own system and ignored on the other.
  const change = (index, fn) => {
    const j = JSON.parse(real);
    for (const groups of Object.values(j.hooks)) for (const g of groups) fn(g.hooks[index]);
    return JSON.stringify(j);
  };
  const tamperedSh = change(0, (h) => { h.args = ['${ZCODE_PLUGIN_ROOT}/scripts/other.sh', h.args[1]]; });
  const tamperedPs = change(1, (h) => { h.args = h.args.slice(0, 3).concat(h.args[3].replace('zn-hook.ps1', 'other.ps1')); });
  const otherWinPath = change(1, (h) => { h.command = 'C:/Temp/powershell.exe'; });
  assert.equal(_internal.zcodeRelevant(read(tamperedSh), true).bare, null, 'a changed sh entry is not judged on Windows');
  assert.ok(_internal.zcodeRelevant(read(tamperedSh), false).bare, 'a changed sh entry is judged on macOS and Linux');
  assert.equal(_internal.zcodeRelevant(read(tamperedPs), false).bare, null, 'a changed PowerShell entry is not judged on macOS and Linux');
  assert.ok(_internal.zcodeRelevant(read(tamperedPs), true).bare, 'a changed PowerShell entry is judged on Windows');
  for (const win of [true]) assert.ok(_internal.zcodeRelevant(read(otherWinPath), win).bare, "another program at a Windows path is not the shipped hook");
  // Any other form of the system PowerShell entry is flagged: extra flags, -EncodedCommand, another command in the text, a script outside the folder.
  const variants = {
    execPolicy: (h) => { h.args = ['-ExecutionPolicy', 'Bypass'].concat(h.args); },
    encoded: (h) => { h.args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('& ./x.ps1', 'utf16le').toString('base64')]; },
    extraCommand: (h) => { h.args = h.args.slice(0, 3).concat(h.args[3] + '; Remove-Item x'); },
    outside: (h) => { h.args = h.args.slice(0, 3).concat(h.args[3].replace("'/scripts/zn-hook.ps1'", "'/../x.ps1'")); },
    extraFlag: (h) => { h.args = h.args.slice(0, 2).concat(['-WindowStyle', 'Hidden'], h.args.slice(2)); },
  };
  for (const [name, fn] of Object.entries(variants)) {
    assert.ok(_internal.zcodeRelevant(read(change(1, fn)), true).bare, name + ': a changed PowerShell entry is flagged on Windows');
  }
  // A Windows path of another program is not "by name", and is not accepted either.
  const j = JSON.parse(real);
  j.hooks.PreToolUse[0].hooks[0].command = 'C:\\Windows\\System32\\cmd.exe';
  const m = _internal.zcodeRelevant(read(JSON.stringify(j)), true);
  assert.match(m.bare.byName, /not a system shell running a script inside the plugin folder/);
  // The same through check on this system.
  const cwd = tempDir(t, 'zn-zcp-two-cwd-');
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), real);
  writeCfg(home, { plugins: { enabledPlugins: { [ID]: true } } });
  let r = await zcodeCheck(home, cwd, SYSPATH);
  assert.equal(r.state, 'protected', r.problem);
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), posix ? tamperedPs : tamperedSh);
  r = await zcodeCheck(home, cwd, SYSPATH);
  assert.equal(r.state, 'protected', 'the entry of the other system is not judged: ' + r.problem);
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), posix ? tamperedSh : tamperedPs);
  r = await zcodeCheck(home, cwd, SYSPATH);
  assert.equal(r.state, 'not-protected');
});
