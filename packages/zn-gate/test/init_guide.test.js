'use strict';

// zn-gate init (guided setup): one route per agent, runs steps only for a person in a terminal with a
// confirmation each, prints them otherwise, never installs hooks from a temporary copy (npx cache) and
// never downgrades a global install, runs programs by absolute path only, ends with zn-gate check.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { guide: realGuide, plan: realPlan, fromTemporaryCopy, _internal } = require('../lib/init-guide');
// These tests are about what they say whatever Node.js runs them: the plugin needs 20.19 or later, so one that
// supports it is injected (the check for older versions is in init_plugin_node.test.js).
const guide = (opts) => realGuide({ nodeVersion: '22.0.0', ...opts });
const plan = (opts) => realPlan({ nodeVersion: '22.0.0', ...opts });
const { AGENT_ENV_VARS } = require('../lib/broker/tty');
const policy = require('../lib/hooks/policy');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const VERSION = require('../package.json').version;
const ZN = path.resolve('/opt/npm/bin/zn');
const NPM = path.resolve('/opt/npm/bin/npm');

function machine(t, agents) {
  const home = tempDir(t, 'zn-init-home-');
  const env = { HOME: home, PATH: '' };
  for (const a of agents) {
    if (a === 'claude-code') fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    if (a === 'codex') fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    if (a === 'cursor') fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  }
  return { home, env, cwd: tempDir(t, 'zn-init-cwd-'), claude: null, ancestry: () => null };
}

function capture() {
  let s = '';
  return { write: (x) => { s += x; }, text: () => s };
}

const tty = { isTTY: true };
const line = (s) => s.manual;

test('plan: one route per agent found; agents not found get no steps', async (t) => {
  const m = machine(t, ['claude-code', 'codex']);
  const { items, setup } = await plan({ ...m, claude: path.resolve('/opt/bin/claude'), temporary: false });
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(by['claude-code'].steps.map(line), ['claude plugin marketplace add usezn/zn@v' + VERSION, 'claude plugin install zn-gate@usezn']);
  assert.deepEqual(by['claude-code'].steps[0].run[1], ['plugin', 'marketplace', 'add', 'usezn/zn@v' + VERSION]);
  assert.equal(by['claude-code'].steps[0].run[0], path.resolve('/opt/bin/claude'));
  assert.deepEqual(by.codex.steps.map(line), ['zn hooks install codex']);
  // An install that stays runs its own CLI with node, by absolute path.
  assert.equal(by.codex.steps[0].run[0], process.execPath);
  assert.deepEqual(by.codex.steps[0].run[1].slice(-3), ['hooks', 'install', 'codex']);
  assert.equal(setup.length, 0);
  assert.equal(by.cursor.found, false);
  assert.equal(by.cursor.steps.length, 0);
});

test('plan: without a claude command, Claude Code gets the two /plugin commands to type', async (t) => {
  const m = machine(t, ['claude-code']);
  const { items } = await plan({ ...m, temporary: false });
  const cc = items.find((i) => i.id === 'claude-code');
  assert.equal(cc.steps.length, 1);
  assert.equal(cc.steps[0].run, null);
  assert.ok(cc.steps[0].manual.includes('/plugin marketplace add usezn/zn@v' + VERSION + ' and then /plugin install zn-gate@usezn'), cc.steps[0].manual);
});

test('plan: from a temporary copy, one global install comes before the hooks, by absolute path', async (t) => {
  const m = machine(t, ['codex', 'cursor']);
  const { items, setup } = await plan({ ...m, temporary: true, global: { npm: NPM } });
  assert.equal(setup.length, 1, 'a single npm step for every agent');
  assert.deepEqual(setup[0].run, [NPM, ['install', '-g', 'zn-gate@' + VERSION]]);
  const cx = items.find((i) => i.id === 'codex');
  assert.equal(cx.steps[0].needsGlobal, true);
});

test('plan: a global install that is the same or newer is kept, never downgraded', async (t) => {
  const m = machine(t, ['codex']);
  const newer = (await plan({ ...m, temporary: true, global: { npm: NPM, version: '99.0.0', zn: ZN } }));
  assert.equal(newer.setup.length, 0);
  assert.deepEqual(newer.items.find((i) => i.id === 'codex').steps[0].run, [ZN, ['hooks', 'install', 'codex']]);
  const older = (await plan({ ...m, temporary: true, global: { npm: NPM, version: '1.0.0', zn: ZN } }));
  assert.equal(older.setup.length, 1);
  assert.match(older.setup[0].label, /you have 1\.0\.0/);
});

test('fromTemporaryCopy: npx, pnpm dlx, yarn dlx and bunx caches; not a global install', () => {
  assert.equal(fromTemporaryCopy('/home/u/.npm/_npx/abc/node_modules/zn-gate/lib'), true);
  assert.equal(fromTemporaryCopy('C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\zn-gate\\lib'), true);
  assert.equal(fromTemporaryCopy('/home/u/.cache/pnpm/dlx-1a2b/node_modules/zn-gate/lib'), true);
  assert.equal(fromTemporaryCopy('/home/u/.cache/pnpm/dlx/5f3c/node_modules/.pnpm/zn-gate@1.9.0/node_modules/zn-gate/lib'), true);
  assert.equal(fromTemporaryCopy('/home/u/.bun/install/cache/zn-gate@1.9.0/lib'), true);
  assert.equal(fromTemporaryCopy('/usr/lib/node_modules/zn-gate/lib'), false);
});

test('findProgram: only absolute PATH entries are searched (a program in the current folder never runs)', (t) => {
  const dir = tempDir(t, 'zn-init-bin-');
  const name = process.platform === 'win32' ? 'zntestprog.cmd' : 'zntestprog';
  fs.writeFileSync(path.join(dir, name), '');
  // Relative entries are resolved against the current folder; on Windows the temp folder can be on another drive.
  const before = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(_internal.findProgram('zntestprog', { PATH: '.' }), null);
    process.chdir(path.dirname(dir));
    assert.equal(_internal.findProgram('zntestprog', { PATH: path.basename(dir) }), null);
    assert.equal(_internal.findProgram('zntestprog', { PATH: '.' + path.delimiter + path.basename(dir) }), null);
  } finally {
    process.chdir(before);
  }
  assert.equal(_internal.findProgram('zntestprog', { PATH: dir }), path.join(dir, name));
});

test('guide: without a terminal it only prints the steps and runs nothing', async (t) => {
  const m = machine(t, ['codex']);
  const out = capture();
  let ran = 0;
  const code = await guide({ ...m, temporary: false, stdin: { isTTY: false }, write: out.write, run: () => { ran++; return true; }, confirm: async () => true });
  assert.equal(ran, 0);
  assert.equal(code, 1);
  assert.match(out.text(), /only prints the steps\. Nothing was changed\./);
  assert.match(out.text(), /zn hooks install codex/);
  assert.match(out.text(), /npx -y zn-gate check/);
  assert.match(out.text(), /zn-gate init --wrap-mcp/);
});

test('guide: when an AI agent runs it, it only prints the steps, also in a terminal', async (t) => {
  const m = machine(t, ['codex']);
  m.env[AGENT_ENV_VARS[0]] = '1';
  const out = capture();
  let ran = 0;
  await guide({ ...m, temporary: false, stdin: tty, write: out.write, run: () => { ran++; return true; }, confirm: async () => true });
  assert.equal(ran, 0);
  assert.match(out.text(), /An AI agent is running this/);
});

test('guide: in a terminal each step is confirmed, run, and the result is checked', async (t) => {
  const m = machine(t, ['codex']);
  const out = capture();
  const asked = [];
  const run = (step) => {
    assert.deepEqual(step.run[1].slice(-3), ['hooks', 'install', 'codex']);
    getAdapter('codex').install({ scope: 'user', home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
    return true;
  };
  const code = await guide({ ...m, temporary: false, stdin: tty, write: out.write, run, confirm: async (q) => { asked.push(q); return true; } });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /zn hooks install codex/);
  assert.match(out.text(), /OK Codex CLI\s+blocked the \.env file/);
  assert.equal(code, 0);
});

test('guide: from a temporary copy the global install runs first, then the hooks with the global zn', async (t) => {
  const m = machine(t, ['codex']);
  const out = capture();
  const ran = [];
  const run = (step) => { ran.push(step.run); return true; };
  await guide({ ...m, temporary: true, global: { npm: NPM, version: null, zn: ZN }, stdin: tty, write: out.write, run, confirm: async () => true });
  assert.deepEqual(ran[0], [NPM, ['install', '-g', 'zn-gate@' + VERSION]]);
  assert.deepEqual(ran[1], [ZN, ['hooks', 'install', 'codex']]);
});

test('guide: declining the global install skips the hooks that need it', async (t) => {
  const m = machine(t, ['codex']);
  const out = capture();
  let ran = 0;
  const code = await guide({ ...m, temporary: true, global: { npm: NPM }, stdin: tty, write: out.write, run: () => { ran++; return true; }, confirm: async () => false });
  assert.equal(ran, 0);
  assert.equal(code, 1);
  assert.match(out.text(), /needs zn-gate installed for your user first/);
});

test('guide: a step the person declines is skipped and shown for later', async (t) => {
  const m = machine(t, ['codex']);
  const out = capture();
  let ran = 0;
  const code = await guide({ ...m, temporary: false, stdin: tty, write: out.write, run: () => { ran++; return true; }, confirm: async () => false });
  assert.equal(ran, 0);
  assert.equal(code, 1);
  assert.match(out.text(), /skipped\. You can run it later: zn hooks install codex/);
});

test('guide: nothing found, and everything already protected', async (t) => {
  const empty = machine(t, []);
  const out = capture();
  assert.equal(await guide({ ...empty, stdin: tty, write: out.write }), 1);
  assert.match(out.text(), /No supported coding agent was found/);
  assert.match(out.text(), /Nothing was changed/);
  const m = machine(t, ['codex']);
  getAdapter('codex').install({ scope: 'user', home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  const out2 = capture();
  assert.equal(await guide({ ...m, stdin: tty, write: out2.write }), 0);
  assert.match(out2.text(), /already protected by zn/);
});

test('agent guard: the guided init is refused to agents; init --wrap-mcp and its options are not', () => {
  for (const cmd of ['zn-gate init', 'npx -y zn-gate init', 'npx -y zn-gate@1.9.0 init', 'script -qfec "npx -y zn-gate init" /dev/null',
    'node /x/bin/cli.js init', 'C:\\npm\\zn-gate.cmd init', 'npx -y zn-gate init; echo --wrap-mcp']) {
    const d = policy.bashDenial(cmd);
    assert.ok(d, 'expected a denial for: ' + cmd);
    assert.match(d, /ask the user to run it in their own terminal/);
  }
  for (const cmd of ['npx -y zn-gate init --wrap-mcp', 'npx -y zn-gate init --dry-run', 'zn-gate init --revert', 'zn-gate init --shadow',
    'npx -y zn-gate check', 'git init', 'npm init -y']) {
    assert.equal(policy.bashDenial(cmd), null, 'expected no denial for: ' + cmd);
  }
});

test('cmp: a prerelease is older than the release', () => {
  assert.ok(_internal.cmp('1.9.0-rc.1', '1.9.0') < 0);
  assert.ok(_internal.cmp('1.9.0', '1.9.0-rc.1') > 0);
  assert.equal(_internal.cmp('1.9.0', '1.9.0'), 0);
  assert.ok(_internal.cmp('1.10.0', '1.9.0') > 0);
});

test('plan: an install that is not the global one (a project dependency, a checkout) uses the global install', async (t) => {
  const m = machine(t, ['codex']);
  const elsewhere = tempDir(t, 'zn-init-global-');
  const { items, setup } = await plan({ ...m, global: { npm: NPM, pkgDir: elsewhere, version: '99.0.0', zn: ZN } });
  assert.equal(setup.length, 0);
  assert.deepEqual(items.find((i) => i.id === 'codex').steps[0].run, [ZN, ['hooks', 'install', 'codex']]);
});

test('agent guard: the options that allow init must be whole words of the same command', () => {
  for (const cmd of ['zn-gate init --wrap-mcp-x', 'zn-gate init --dry-run=1', 'zn-gate init --shadow.', 'zn-gate init # --dry-run',
    "zn-gate init 'x --revert'", 'zn-gate init > --dry-run', 'zn-gate init 2> --shadow', 'zn-gate init < --revert', 'zn-gate init $(: --dry-run)', 'zn-gate init `: --dry-run`', 'zn-gate init --wrap-mcp && zn-gate init']) {
    assert.ok(policy.bashDenial(cmd), 'expected a denial for: ' + cmd);
  }
  assert.equal(policy.bashDenial('zn-gate init --dry-run --shadow'), null);
  assert.equal(policy.bashDenial('zn-gate init --dry-run > out.txt'), null);
});

test('agent guard: many init words with an option at the end stay fast', () => {
  const cmd = 'zn init '.repeat(Math.floor(99 * 1024 / 8)) + ' --dry-run';
  const t0 = Date.now();
  policy.bashDenial(cmd);
  assert.ok(Date.now() - t0 < 500, 'took ' + (Date.now() - t0) + ' ms');
});

test('plan: Claude Code set up with zn hooks is repaired with zn hooks, not with the plugin', async (t) => {
  const m = machine(t, ['claude-code']);
  getAdapter('claude-code').install({ scope: 'user', home: m.home, env: m.env, nodePath: path.join(m.home, 'gone', 'node'), runnerPath: RUNNER, mcp: false });
  const { items } = await plan({ ...m, claude: path.resolve('/opt/bin/claude'), temporary: false });
  const cc = items.find((i) => i.id === 'claude-code');
  assert.equal(cc.state, 'not-protected');
  assert.deepEqual(cc.steps.map(line), ['zn hooks install claude-code']);
});

test('plan: the plugin together with zn hooks gets one step that removes the hooks', async (t) => {
  const m = machine(t, ['claude-code']);
  getAdapter('claude-code').install({ scope: 'user', home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  const root = path.join(m.home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate', '1.9.0');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'zn-launch.js'), "const [mode] = process.argv.slice(2); if (mode === 'check') process.exit(0);\n" +
    "const r = require('child_process').spawnSync(process.execPath, [" + JSON.stringify(RUNNER) + ", 'claude-code'], { input: require('fs').readFileSync(0), encoding: 'utf8' });\n" +
    "process.stdout.write(r.stdout || ''); process.exit(r.status || 0);\n");
  fs.writeFileSync(path.join(m.home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'zn-gate@usezn': [{ scope: 'user', installPath: root }] } }));
  const { items } = await plan({ ...m, claude: path.resolve('/opt/bin/claude'), temporary: false });
  const cc = items.find((i) => i.id === 'claude-code');
  assert.deepEqual(cc.steps.map(line), ['zn hooks uninstall claude-code']);
  assert.match(cc.steps[0].label, /the zn-gate plugin stays/);
});

function pluginIn(home, enabled) {
  const root = path.join(home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate', '1.9.0');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'zn-launch.js'), "const [mode] = process.argv.slice(2); if (mode === 'check') process.exit(0);\n" +
    "const r = require('child_process').spawnSync(process.execPath, [" + JSON.stringify(RUNNER) + ", 'claude-code'], { input: require('fs').readFileSync(0), encoding: 'utf8' });\n" +
    "process.stdout.write(r.stdout || ''); process.exit(r.status || 0);\n");
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'zn-gate@usezn': [{ scope: 'user', installPath: root }] } }));
  if (enabled === false) {
    const file = path.join(home, '.claude', 'settings.json');
    let tree = {};
    try { tree = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* none yet */ }
    tree.enabledPlugins = { 'zn-gate@usezn': false };
    fs.writeFileSync(file, JSON.stringify(tree));
  }
}

test('plan: a plugin turned off next to zn hooks never removes the hooks', async (t) => {
  const m = machine(t, ['claude-code']);
  getAdapter('claude-code').install({ scope: 'user', home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  pluginIn(m.home, false);
  const { items } = await plan({ ...m, claude: path.resolve('/opt/bin/claude'), temporary: false });
  const cc = items.find((i) => i.id === 'claude-code');
  assert.equal(cc.state, 'protected');
  assert.deepEqual(cc.steps, []);
});

test('plan: a plugin alone that is turned off gets one step that turns it on', async (t) => {
  const m = machine(t, ['claude-code']);
  pluginIn(m.home, false);
  const { items } = await plan({ ...m, claude: path.resolve('/opt/bin/claude'), temporary: false });
  const cc = items.find((i) => i.id === 'claude-code');
  assert.deepEqual(cc.steps.map(line), ['claude plugin enable zn-gate@usezn']);
});

test('agent guard: a backslash before the option and npm exec options do not unlock the guided init', () => {
  for (const cmd of ['zn-gate init x\\ --wrap-mcp', 'npx -y zn-gate init a\\ --dry-run', 'npm exec zn-gate init --dry-run',
    'npm x zn-gate init --wrap-mcp', 'npm exec -y zn-gate@1.9.0 init --revert', 'npm.cmd exec zn-gate init --shadow']) {
    const d = policy.bashDenial(cmd);
    assert.ok(d, 'expected a denial for: ' + cmd);
    assert.match(d, /ask the user to run it in their own terminal/);
  }
  for (const cmd of ['npm exec -- zn-gate init --dry-run', 'npm exec zn-gate -- init --wrap-mcp', 'npx -y zn-gate init --wrap-mcp', 'npm exec zn-gate check', 'npm init -y']) {
    assert.equal(policy.bashDenial(cmd), null, 'expected no denial for: ' + cmd);
  }
});

test('agent guard: the npm exec check stays fast', () => {
  const t0 = process.hrtime.bigint();
  assert.equal(policy.adminCommand('npm exec ' + 'a '.repeat(40000) + 'zn-gate init --dry-run'), 'init');
  assert.equal(policy.adminCommand(('npm x ' + 'b'.repeat(50) + ' ').repeat(1500)), null);
  assert.equal(policy.adminCommand(('npm exec ' + '-- '.repeat(20)).repeat(1500)), null);
  assert.equal(policy.adminCommand('npm' + ' -a b'.repeat(15000) + ' exec zn-gate init --dry-run'), 'init');
  policy.adminCommand('npm' + ' -a b'.repeat(15000) + ' install');
  assert.equal(policy.adminCommand('npm exec ' + '--yes '.repeat(200) + 'zn-gate init --dry-run'), 'init', 'padding does not hide it');
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 500);
});

test('agent guard: Unicode spaces, carriage returns and more npm exec forms do not unlock it (capitals: the CLI refuses them)', () => {
  for (const cmd of ['zn-gate init x\u00a0--wrap-mcp', 'zn-gate init --wrap-mcp\u00a0', 'zn-gate init x\r--wrap-mcp', 'zn-gate init --wrap-mcp\r',
    'zn-gate init x\u3000--dry-run', 'zn-gate init x\ufeff--revert',
    'npm --yes exec zn-gate init --dry-run', 'npm -y x zn-gate init --wrap-mcp', '/usr/local/bin/npm exec zn-gate init --dry-run',
    'node /opt/npm/bin/npm-cli.js exec zn-gate init --dry-run', '"npm" exec zn-gate init --dry-run', "npm exec 'zn-gate' init --dry-run",
    'npm exec "zn-gate@latest" init --wrap-mcp', 'npm exec zn init --dry-run', 'npm exe zn-gate init --revert',
    'npm --prefix /tmp/x exec zn-gate init --dry-run', 'npm --loglevel warn exec zn-gate init --wrap-mcp']) {
    assert.ok(policy.bashDenial(cmd), 'expected a denial for: ' + JSON.stringify(cmd));
  }
  for (const cmd of ['npm exec -- zn-gate init --dry-run', 'npm exec zn-gate -- init --wrap-mcp', 'npx -y zn-gate@latest init --revert',
    'npx -y zn-gate init --wrap-mcp --shadow', 'npm x tsc -- --init', 'npm init -y', 'npm -w pkg exec vitest', 'npm --prefix /tmp/x exec -- zn-gate init --dry-run']) {
    assert.equal(policy.bashDenial(cmd), null, 'expected no denial for: ' + cmd);
  }
});

test('the guided init refuses any argument, on the real argument list', () => {
  const { spawnSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'bin', 'cli.js');
  for (const a of ['x --wrap-mcp', '--WRAP-MCP', '--wrap-mcp\u00a0', 'extra']) {
    const r = spawnSync(process.execPath, [cli, 'init', a], { encoding: 'utf8', env: { ...process.env, ZN_STATS: 'off' }, timeout: 20000 });
    assert.equal(r.status, 2, a + ': ' + r.stderr);
    assert.match(r.stderr, /^zn-gate init: unknown argument "/);
    assert.doesNotMatch(r.stdout, /guided|zn-gate check/i);
  }
});

test('agent variables count when present, also when empty', () => {
  const tty = require('../lib/broker/tty');
  assert.equal(tty.agentEnvDetected({ CLAUDECODE: '' }), 'CLAUDECODE');
  assert.equal(tty.agentEnvDetected({ PATH: '/usr/bin' }), null);
});

test('plan: a broken plugin next to zn hooks gets one step that turns the plugin off', async (t) => {
  const m = machine(t, ['claude-code']);
  getAdapter('claude-code').install({ scope: 'user', home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  const root = path.join(m.home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate', '1.9.0');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'zn-launch.js'), "process.stderr.write('zn plugin: zn-gate is not installed'); process.exit(2);\n");
  fs.writeFileSync(path.join(m.home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'zn-gate@usezn': [{ scope: 'user', installPath: root }] } }));
  const { items } = await plan({ ...m, claude: path.resolve('/opt/bin/claude'), temporary: false });
  const cc = items.find((i) => i.id === 'claude-code');
  assert.deepEqual(cc.steps.map(line), ['claude plugin disable zn-gate@usezn']);
});

function brokenPluginIn(home) {
  const root = path.join(home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate', '1.9.0');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'zn-launch.js'), "process.stderr.write('zn plugin: zn-gate is not installed'); process.exit(2);\n");
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'zn-gate@usezn': [{ scope: 'user', installPath: root }] } }));
}

const goneNode = (m) => getAdapter('claude-code').install({ scope: 'user', home: m.home, env: m.env, nodePath: '/nonexistent/bin/node', runnerPath: RUNNER, mcp: false });

test('plan: a broken plugin next to zn hooks that do not work either repairs the hooks first, then turns the plugin off', async (t) => {
  const m = machine(t, ['claude-code']);
  goneNode(m);
  brokenPluginIn(m.home);
  const { items, setup } = await plan({ ...m, claude: path.resolve('/opt/bin/claude'), temporary: false });
  const cc = items.find((i) => i.id === 'claude-code');
  assert.deepEqual(cc.steps.map(line), ['zn hooks install claude-code', 'zn-gate check (go on only if it says the hooks work)', 'claude plugin disable zn-gate@usezn']);
  assert.equal(setup.length, 0);
  // From a temporary copy, the global install comes first, then the hooks with the global zn, then the plugin off.
  const tmp = await plan({ ...m, claude: path.resolve('/opt/bin/claude'), temporary: true, global: { npm: NPM, zn: ZN } });
  const t2 = tmp.items.find((i) => i.id === 'claude-code');
  assert.deepEqual(tmp.setup.map(line), ['npm install -g zn-gate@' + VERSION]);
  assert.deepEqual(t2.steps.map(line), ['zn hooks install claude-code', 'zn-gate check (go on only if it says the hooks work)', 'claude plugin disable zn-gate@usezn']);
  assert.deepEqual(t2.steps[0].run, [ZN, ['hooks', 'install', 'claude-code']]);
});

test('guide: the plugin is never turned off while the hooks are not repaired', async (t) => {
  const m = machine(t, ['claude-code']);
  goneNode(m);
  brokenPluginIn(m.home);
  for (const outcome of ['declined', 'failed']) {
    const out = capture();
    const ran = [];
    const confirm = async () => outcome !== 'declined';
    const run = (step) => { ran.push(step.manual); return false; };
    await guide({ ...m, claude: path.resolve('/opt/bin/claude'), temporary: false, stdin: tty, write: out.write, confirm, run });
    assert.ok(!ran.includes('claude plugin disable zn-gate@usezn'), outcome + ': ' + ran.join(', '));
  }
});

test('guide: after repairing the hooks next to a broken plugin, the plugin is turned off only when the hooks work', async (t) => {
  for (const repairs of [false, true]) {
    const m = machine(t, ['claude-code']);
    goneNode(m);
    brokenPluginIn(m.home);
    const out = capture();
    const ran = [];
    // The hooks step "succeeds"; it really repairs the hooks only in the second round.
    const run = (step) => {
      ran.push(step.manual);
      if (repairs && step.manual === 'zn hooks install claude-code') {
        getAdapter('claude-code').install({ scope: 'user', home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
      }
      return true;
    };
    await guide({ ...m, claude: path.resolve('/opt/bin/claude'), temporary: false, stdin: tty, write: out.write, confirm: async () => true, run });
    if (repairs) {
      assert.deepEqual(ran, ['zn hooks install claude-code', 'claude plugin disable zn-gate@usezn']);
      assert.match(out.text(), /check that zn's hooks for Claude Code work now: yes/);
    } else {
      assert.deepEqual(ran, ['zn hooks install claude-code']);
      assert.match(out.text(), /check that zn's hooks for Claude Code work now: not yet \(.+\)\. The zn-gate plugin was left on\./);
    }
  }
});

test('plan: zn rules that do not block .env get the zn-gate repair, never the plugin install', async (t) => {
  const runner = require('../lib/hooks/runner');
  const real = runner.handle;
  runner.handle = async () => ({ decision: { decision: 'allow' } });
  t.after(() => { runner.handle = real; });
  const m = machine(t, ['claude-code']);
  pluginIn(m.home);
  const { items } = await plan({ ...m, claude: path.resolve('/opt/bin/claude'), temporary: false });
  const cc = items.find((i) => i.id === 'claude-code');
  assert.deepEqual(cc.steps.map(line), ['install zn-gate again: run `npm install -g zn-gate` in your own terminal, then run `zn-gate check` again']);
  assert.equal(cc.steps[0].run, null);
  // Claude Code set up with zn hooks only, and a broken plugin next to broken hooks: the same single step.
  const h = machine(t, ['claude-code']);
  getAdapter('claude-code').install({ scope: 'user', home: h.home, env: h.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  const b = machine(t, ['claude-code']);
  goneNode(b);
  brokenPluginIn(b.home);
  for (const mm of [h, b]) {
    const r = (await plan({ ...mm, claude: path.resolve('/opt/bin/claude'), temporary: false })).items.find((i) => i.id === 'claude-code');
    assert.deepEqual(r.steps.map(line), cc.steps.map(line));
  }
});

test('plan: a Claude Code setting that stops all hooks, with the plugin and zn hooks, touches neither set', async (t) => {
  const m = machine(t, ['claude-code']);
  getAdapter('claude-code').install({ scope: 'user', home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  pluginIn(m.home, true);
  const file = path.join(m.home, '.claude', 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), disableAllHooks: true }));
  const { items } = await plan({ ...m, claude: path.resolve('/opt/bin/claude'), temporary: false });
  const cc = items.find((i) => i.id === 'claude-code');
  assert.equal(cc.state, 'not-protected');
  assert.match(cc.problem, /disableAllHooks/);
  assert.equal(cc.steps.length, 1);
  assert.equal(cc.steps[0].run, null);
  assert.doesNotMatch(cc.steps.map(line).join(' '), /plugin disable|hooks uninstall|hooks install/);
});

test('plan: a plugin turned off next to broken zn hooks repairs the hooks only', async (t) => {
  const m = machine(t, ['claude-code']);
  goneNode(m);
  pluginIn(m.home, false);
  const { items } = await plan({ ...m, claude: path.resolve('/opt/bin/claude'), temporary: false });
  const cc = items.find((i) => i.id === 'claude-code');
  assert.equal(cc.state, 'not-protected');
  assert.deepEqual(cc.steps.map(line), ['zn hooks install claude-code']);
});

const posixOnly = { skip: process.platform === 'win32' && 'EACCES is a POSIX failure' };

test('guide: npm failing with EACCES gives a clear next step, never sudo', posixOnly, async (t) => {
  const m = machine(t, ['codex', 'cursor']);
  const out = capture();
  const run = () => ({ ok: false, stderr: 'npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules\n' });
  const code = await guide({ ...m, temporary: true, global: { npm: NPM, version: null, zn: ZN, prefix: '/usr/local' }, shell: '/bin/zsh', stdin: tty, write: out.write, run, confirm: async () => true });
  const text = out.text();
  assert.equal(code, 1);
  assert.match(text, /npm is not allowed to write to its global folder \(\/usr\/local\)/);
  assert.match(text, /Codex CLI, Cursor stay unprotected/);
  assert.match(text, /npm config set prefix ~\/\.npm-global/);
  assert.match(text, /export PATH="\$HOME\/\.npm-global\/bin:\$PATH"' >> ~\/\.zshrc/);
  assert.match(text, /npx -y zn-gate init/);
  assert.match(text, /nvm/);
  assert.doesNotMatch(text, /sudo/);
  assert.doesNotMatch(text, /Run it yourself/);
});

test('guide: any other npm failure keeps the plain message', posixOnly, async (t) => {
  const m = machine(t, ['codex']);
  const out = capture();
  const run = () => ({ ok: false, stderr: 'npm error code ENOTFOUND\n' });
  await guide({ ...m, temporary: true, global: { npm: NPM, version: null, zn: ZN }, stdin: tty, write: out.write, run, confirm: async () => true });
  assert.match(out.text(), /that did not finish\. Run it yourself: npm install -g zn-gate@/);
  assert.doesNotMatch(out.text(), /global folder/);
  // A step stub that only returns false (no output) also keeps it.
  const out2 = capture();
  await guide({ ...m, temporary: true, global: { npm: NPM, version: null, zn: ZN }, stdin: tty, write: out2.write, run: () => false, confirm: async () => true });
  assert.match(out2.text(), /Run it yourself/);
});

test('permissionFailure: a global folder that is not writable counts, a missing one does not', posixOnly, (t) => {
  const { permissionFailure } = _internal;
  assert.equal(permissionFailure('', ''), false);
  assert.equal(permissionFailure('npm ERR! EPERM: operation not permitted', ''), true);
  assert.equal(permissionFailure('', path.join(tempDir(t, 'zn-prefix-'), 'does-not-exist')), false);
  assert.equal(permissionFailure('', tempDir(t, 'zn-prefix-')), false);
});
