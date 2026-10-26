'use strict';

// The Claude Code plugin needs Node.js 20.19 or later, zn-gate itself runs on 18 and later. With an older
// Node.js, init does not install the plugin and sets up zn's hooks instead, and check says so when the plugin
// is installed. The Node.js version is injected (nodeVersion): the real runtime is never changed.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { guide, plan } = require('../lib/init-guide');
const { check, _internal } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');
const { writePluginManifest } = require('./helpers/claude_plugin');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const CLAUDE = path.resolve('/opt/bin/claude');
const line = (s) => s.manual;
const PLUGIN_STEPS = ['claude plugin marketplace add usezn/zn', 'claude plugin install zn-gate@usezn'];

function machine(t) {
  const home = tempDir(t, 'zn-initnode-home-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { home, env: { HOME: home, PATH: '' }, cwd: tempDir(t, 'zn-initnode-cwd-'), claude: CLAUDE, ancestry: () => null, temporary: false };
}

function pluginIn(home) {
  const root = path.join(home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate', '1.9.0');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'zn-launch.js'), "const [mode] = process.argv.slice(2); if (mode === 'check') process.exit(0);\n" +
    "const r = require('child_process').spawnSync(process.execPath, [" + JSON.stringify(RUNNER) + ", 'claude-code'], { input: require('fs').readFileSync(0), encoding: 'utf8' });\n" +
    "process.stdout.write(r.stdout || ''); process.exit(r.status || 0);\n");
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'zn-gate@usezn': [{ scope: 'user', installPath: root }] } }));
  writePluginManifest(root);
}

const ccOf = (items) => items.find((i) => i.id === 'claude-code');

test('pluginNodeOk: 20.19 is the first supported version', () => {
  const ok = _internal.pluginNodeOk;
  for (const v of ['18.19.0', '20.0.0', '20.11.1', '20.12.0', '20.18.3', '21.0.0', '21.6.0']) assert.equal(ok(v), false, v);
  for (const v of ['20.19.0', '20.19.5', '20.20.0', '21.7.0', '22.0.0', '24.21.0']) assert.equal(ok(v), true, v);
});

test('init plan: Node.js 20.19 or later still installs the plugin, with no note', async (t) => {
  for (const v of ['20.19.0', '22.5.1']) {
    const m = machine(t);
    const cc = ccOf((await plan({ ...m, nodeVersion: v })).items);
    assert.deepEqual(cc.steps.map(line), PLUGIN_STEPS, v);
    assert.equal(cc.note, undefined, v);
  }
});

test('init plan: before 20.19 the plugin is skipped and zn hooks are installed instead', async (t) => {
  for (const v of ['18.19.0', '20.11.1', '20.18.3']) {
    const m = machine(t);
    const cc = ccOf((await plan({ ...m, nodeVersion: v })).items);
    assert.deepEqual(cc.steps.map(line), ['zn hooks install claude-code'], v);
    assert.equal(cc.note, 'Claude Code plugin skipped: it needs Node.js 20.19 or later (you have ' + v + '). zn\'s hooks are set up instead; update Node.js to use the plugin.');
  }
});

test('init plan: before 20.19 without a claude command, the /plugin commands are not offered either', async (t) => {
  const m = machine(t);
  const cc = ccOf((await plan({ ...m, claude: null, nodeVersion: '18.19.0' })).items);
  assert.deepEqual(cc.steps.map(line), ['zn hooks install claude-code']);
});

test('init: the skipped plugin is said in one line, once', async (t) => {
  const m = machine(t);
  let out = '';
  const code = await guide({ ...m, nodeVersion: '18.19.0', stdin: { isTTY: false }, write: (s) => { out += s; } });
  assert.equal(code, 1);
  const lines = out.split('\n').filter((l) => /plugin skipped/.test(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Claude Code plugin skipped: it needs Node\.js 20\.19 or later \(you have 18\.19\.0\)\./);
  assert.match(out, /zn hooks install claude-code/);
  assert.doesNotMatch(out, /claude plugin install/);
});

test('init: on Node.js 20.19 or later the guide says nothing about a skipped plugin', async (t) => {
  const m = machine(t);
  let out = '';
  await guide({ ...m, nodeVersion: '20.19.0', stdin: { isTTY: false }, write: (s) => { out += s; } });
  assert.doesNotMatch(out, /skipped/);
  assert.match(out, /claude plugin install zn-gate@usezn/);
});

test('init plan: a plugin installed next to an older Node.js is replaced by zn hooks', async (t) => {
  const m = machine(t);
  pluginIn(m.home);
  const cc = ccOf((await plan({ ...m, nodeVersion: '18.19.0' })).items);
  assert.deepEqual(cc.steps.map(line), ['zn hooks install claude-code', 'zn-gate check (go on only if it says the hooks work)', 'claude plugin disable zn-gate@usezn']);
  assert.match(cc.note, /^Claude Code plugin will be turned off: it needs Node\.js 20\.19 or later \(you have 18\.19\.0\); zn's hooks will be used instead/);
});

test('init (interactive): a plugin on an older Node.js: hooks installed, checked, and only then the plugin turned off', async (t) => {
  const m = machine(t);
  pluginIn(m.home);
  const order = [];
  let out = '';
  await guide({
    ...m, nodeVersion: '18.19.0', stdin: { isTTY: true }, write: (s) => { out += s; },
    confirm: async () => true,
    // The run stand-in does what the real commands do: the hooks are written, the plugin switch is only recorded.
    run: (step) => {
      order.push(step.manual);
      if (/^zn hooks install/.test(step.manual)) {
        getAdapter('claude-code').install({ scope: 'user', home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
      }
      return true;
    },
  });
  assert.deepEqual(order, ['zn hooks install claude-code', 'claude plugin disable zn-gate@usezn']);
  assert.match(out, /check that zn's hooks for Claude Code work now: yes/);
  assert.ok(out.indexOf('plugin will be turned off') < out.indexOf('check that zn'), 'the plan comes first');
  assert.ok(out.indexOf('Claude Code plugin turned off;') > out.indexOf('check that zn'), 'the confirmation comes after the steps');
});

test('init: the plugin is only said to be turned off when it was; declined, or without a terminal, it is not', async (t) => {
  const m = machine(t);
  pluginIn(m.home);
  let out = '';
  await guide({ ...m, nodeVersion: '18.19.0', stdin: { isTTY: true }, write: (s) => { out += s; }, confirm: async () => false, run: () => true });
  assert.doesNotMatch(out, /Claude Code plugin turned off;/);
  out = '';
  await guide({ ...m, nodeVersion: '18.19.0', stdin: { isTTY: false }, write: (s) => { out += s; } });
  assert.doesNotMatch(out, /Claude Code plugin turned off;/);
  assert.match(out, /will be turned off/);
  // The hooks step runs, but the disable step fails: no confirmation.
  out = '';
  await guide({
    ...m, nodeVersion: '18.19.0', stdin: { isTTY: true }, write: (s) => { out += s; }, confirm: async () => true,
    run: (step) => {
      if (/^zn hooks install/.test(step.manual)) getAdapter('claude-code').install({ scope: 'user', home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
      return !/plugin disable/.test(step.manual);
    },
  });
  assert.doesNotMatch(out, /Claude Code plugin turned off;/);
  assert.match(out, /that did not finish/);
});

test('check: a plugin on Node.js before 20.19 is reported, with the way out', async (t) => {
  const m = machine(t);
  pluginIn(m.home);
  const r = (await check({ home: m.home, env: m.env, cwd: m.cwd, nodeVersion: '18.19.0' })).results.find((x) => x.id === 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.equal(r.problem, 'the zn-gate plugin needs Node.js 20.19 or later (you have 18.19.0)');
  assert.match(r.fix, /update Node\.js to 20\.19 or later/);
  assert.match(r.fix, /zn hooks install claude-code/);
  assert.match(r.fix, /claude plugin disable zn-gate@usezn/);
});

test('check: the same plugin on Node.js 20.19 or later is protected', async (t) => {
  const m = machine(t);
  pluginIn(m.home);
  const r = (await check({ home: m.home, env: m.env, cwd: m.cwd, nodeVersion: '20.19.0' })).results.find((x) => x.id === 'claude-code');
  assert.equal(r.state, 'protected', r.problem);
});

test('check: zn hooks without the plugin are protected whatever the Node.js version', async (t) => {
  const m = machine(t);
  getAdapter('claude-code').install({ scope: 'user', home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  const r = (await check({ home: m.home, env: m.env, cwd: m.cwd, nodeVersion: '18.19.0' })).results.find((x) => x.id === 'claude-code');
  assert.equal(r.state, 'protected', r.problem);
});

test('check: plugin and zn hooks on an older Node.js say the plugin is what does not work', async (t) => {
  const m = machine(t);
  getAdapter('claude-code').install({ scope: 'user', home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  pluginIn(m.home);
  const r = (await check({ home: m.home, env: m.env, cwd: m.cwd, nodeVersion: '18.19.0' })).results.find((x) => x.id === 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /the zn-gate plugin does not work here \(the zn-gate plugin needs Node\.js 20\.19 or later \(you have 18\.19\.0\)\)/);
});

test('one constant sets the plugin Node.js version: code, messages and the launcher agree', () => {
  const { PLUGIN_NODE_MIN, pluginNodeOk, pluginNodeMessage } = require('../lib/check')._internal;
  assert.equal(PLUGIN_NODE_MIN, '20.19');
  assert.equal(pluginNodeOk(PLUGIN_NODE_MIN + '.0'), true);
  assert.equal(pluginNodeOk('20.18.9'), false);
  assert.ok(pluginNodeMessage('18.19.0').includes('Node.js ' + PLUGIN_NODE_MIN + ' or later'));
  const launcher = require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', 'plugins', 'zn-gate', 'scripts', 'zn-launch.js'), 'utf8');
  assert.ok(launcher.includes('Node.js ' + PLUGIN_NODE_MIN + ' or later'), 'the plugin launcher names the same version');
});

// The plugin's hooks run the `node` found on PATH, which can differ from the Node.js running zn-gate (npx, nvm).
const HOOK18 = { version: '18.19.0', path: path.join(path.sep, 'usr', 'bin', 'node') };
const HOOK22 = { version: '22.3.0', path: path.join(path.sep, 'opt', 'node22', 'bin', 'node') };

test('pluginNodeStatus: the Node.js of the hooks decides, and the message says which one', () => {
  const st = _internal.pluginNodeStatus;
  const a = st({ nodeVersion: '22.0.0', hookNode: HOOK18 });
  assert.equal(a.ok, false);
  assert.equal(a.why, 'Claude Code will run the hooks of the plugin with Node.js 18.19.0 (from ' + HOOK18.path + '); zn-gate itself runs on Node.js 22.0.0');
  assert.equal(st({ nodeVersion: '18.19.0', hookNode: HOOK22 }).ok, true);
  assert.equal(st({ nodeVersion: '22.0.0', hookNode: () => HOOK22 }).ok, true);
  const same = st({ nodeVersion: '18.19.0' });
  assert.equal(same.why, 'you have 18.19.0');
  const unknown = st({ nodeVersion: '22.0.0', hookNode: null });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.unknown, true);
});

test('init plan: zn-gate on Node.js 22 but the hooks on 18 skips the plugin and says why', async (t) => {
  const m = machine(t);
  const cc = ccOf((await plan({ ...m, nodeVersion: '22.0.0', hookNode: HOOK18 })).items);
  assert.deepEqual(cc.steps.map(line), ['zn hooks install claude-code']);
  assert.match(cc.note, /^Claude Code plugin skipped: it needs Node\.js 20\.19 or later \(Claude Code will run the hooks of the plugin with Node\.js 18\.19\.0 \(from .*\); zn-gate itself runs on Node\.js 22\.0\.0\)\./);
});

test('init plan: zn-gate on Node.js 18 but the hooks on 22 still installs the plugin', async (t) => {
  const m = machine(t);
  const cc = ccOf((await plan({ ...m, nodeVersion: '18.19.0', hookNode: HOOK22 })).items);
  assert.deepEqual(cc.steps.map(line), PLUGIN_STEPS);
  assert.equal(cc.note, undefined);
});

test('init plan: a node that cannot be found or run never installs the plugin silently', async (t) => {
  const m = machine(t);
  const cc = ccOf((await plan({ ...m, nodeVersion: '22.0.0', hookNode: null })).items);
  assert.deepEqual(cc.steps.map(line), ['zn hooks install claude-code']);
  assert.match(cc.note, /^Claude Code plugin skipped: zn-gate could not find or run the `node` that the hooks of the plugin start with/);
});

test('check: a plugin whose hooks run on an older Node.js than zn-gate is reported with both versions', async (t) => {
  const m = machine(t);
  pluginIn(m.home);
  const r = (await check({ home: m.home, env: m.env, cwd: m.cwd, nodeVersion: '22.0.0', hookNode: HOOK18 })).results.find((x) => x.id === 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /Claude Code will run the hooks of the plugin with Node\.js 18\.19\.0 .*zn-gate itself runs on Node\.js 22\.0\.0/);
  assert.match(r.fix, /first `node` on your PATH/);
});

test('check: a node that cannot be found is reported as unknown, not as a pass', async (t) => {
  const m = machine(t);
  pluginIn(m.home);
  const r = (await check({ home: m.home, env: m.env, cwd: m.cwd, nodeVersion: '22.0.0', hookNode: null })).results.find((x) => x.id === 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /could not find or run the `node`/);
  assert.match(r.fix, /node --version/);
});

test('resolveHookNode: finds nothing on an empty PATH and never throws', () => {
  assert.equal(_internal.resolveHookNode({ PATH: '' }), null);
  assert.equal(_internal.resolveHookNode({ PATH: path.join(path.sep, 'no', 'such', 'dir') }), null);
  const own = _internal.resolveHookNode({ PATH: path.dirname(process.execPath) });
  assert.ok(own && own.version === process.versions.node);
});
