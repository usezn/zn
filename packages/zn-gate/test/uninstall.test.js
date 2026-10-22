'use strict';

// zn-gate uninstall: prints a plan, changes nothing with --dry-run or without a terminal (exit 77),
// removes hooks, the plugin and wrapped MCP servers after one confirmation, and deletes the vault only
// after a second one. Everything runs in a temporary home folder: no real user file is touched.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { getAdapter } = require('../lib/agents');
const { dispatch } = require('../lib/broker/cli');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const PLUGIN = 'zn-gate@usezn';

function machine(t) {
  const home = tempDir(t, 'zn-uninst-home-');
  const cwd = tempDir(t, 'zn-uninst-cwd-');
  for (const d of ['.claude', '.codex']) fs.mkdirSync(path.join(home, d), { recursive: true });
  return { home, cwd, env: { HOME: home, USERPROFILE: home, PATH: '' } };
}

function io(m, extra = {}) {
  let out = '';
  let err = '';
  const o = {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    stdin: { isTTY: true },
    env: m.env, home: m.home, cwd: m.cwd, human: true, claude: null, ancestry: () => null,
    envList: [],
    ...extra,
  };
  return { o, out: () => out, err: () => err };
}

const install = (m, id, scope = 'user') => getAdapter(id).install({
  scope, projectDir: m.cwd, home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false,
});

function plugin(m) {
  const root = path.join(m.home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate', '1.9.0');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'zn-launch.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(m.home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [PLUGIN]: [{ scope: 'user', installPath: root }] } }));
  return root;
}

function wrapped(m) {
  const file = path.join(m.home, 'mcp-config.json');
  const original = JSON.stringify({ mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } } }, null, 2);
  fs.writeFileSync(file, original);
  const list = [{ name: 'Example MCP', id: 'example', filePath: file, key: 'mcpServers' }];
  require('../lib/init').configureEnvironments({ envList: list });
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.fetch.args.includes('shield'));
  return { file, original, list };
}

function vault(m) {
  const dir = path.join(m.home, '.zn', 'vault');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'secrets.age'), 'not a real vault\n');
  return path.join(dir, 'secrets.age');
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const settings = (m) => path.join(m.home, '.claude', 'settings.json');
const znHooksIn = (file) => /runner\.js|zn hook/.test(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

test('uninstall: the plan lists the plugin, hooks per agent, project hooks and wrapped MCP, with paths', async (t) => {
  const m = machine(t);
  const root = plugin(m);
  install(m, 'codex');
  install(m, 'claude-code', 'project');
  const w = wrapped(m);
  const v = vault(m);
  const c = io(m, { envList: w.list });
  assert.equal(await dispatch('uninstall', ['--dry-run'], c.o), 0);
  const text = c.out();
  assert.match(text, /Will be removed:/);
  assert.ok(text.includes('the zn-gate plugin (' + root + ')'));
  assert.ok(text.includes(path.join(m.home, '.codex', 'hooks.json')));
  assert.ok(text.includes('zn\'s hooks for this project: ' + path.join(m.cwd, '.claude', 'settings.json')));
  assert.ok(text.includes('Example MCP (1 wrapped)'));
  assert.match(text, /each wrapped server gets its original command back/);
  assert.match(text, /Asked separately at the end \(default no\)/);
  assert.ok(text.includes(path.dirname(path.dirname(v))));
  assert.match(text, /dry run: nothing was changed/);
});

test('uninstall: --dry-run changes nothing', async (t) => {
  const m = machine(t);
  plugin(m);
  install(m, 'codex');
  install(m, 'claude-code');
  const w = wrapped(m);
  const v = vault(m);
  const files = [path.join(m.home, '.codex', 'hooks.json'), settings(m), w.file, v];
  const before = files.map(sha);
  const asked = [];
  const c = io(m, { envList: w.list, confirm: async (q) => { asked.push(q); return true; }, run: () => { throw new Error('must not run'); } });
  assert.equal(await dispatch('uninstall', ['--dry-run'], c.o), 0);
  assert.deepEqual(files.map(sha), before);
  assert.deepEqual(asked, []);
  assert.equal(fs.readdirSync(m.home).filter((f) => f.startsWith('mcp-config.json.bak.')).length, 1, 'no new backup');
});

test('uninstall: without a terminal it prints the plan, changes nothing and exits 77', async (t) => {
  const m = machine(t);
  install(m, 'codex');
  const f = path.join(m.home, '.codex', 'hooks.json');
  const before = sha(f);
  const c = io(m, { human: false, stdin: { isTTY: false } });
  assert.equal(await dispatch('uninstall', [], c.o), 77);
  assert.match(c.out(), /Will be removed:/);
  assert.match(c.err(), /terminal/i);
  assert.equal(sha(f), before);
});

test('uninstall: the real command exits 77 without a terminal and leaves files alone', (t) => {
  const m = machine(t);
  install(m, 'codex');
  const f = path.join(m.home, '.codex', 'hooks.json');
  const before = sha(f);
  const r = spawnSync(process.execPath, [CLI, 'uninstall'], { env: { HOME: m.home, USERPROFILE: m.home, PATH: process.env.PATH }, cwd: m.cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  assert.equal(r.status, 77, r.stdout + r.stderr);
  assert.match(r.stdout, /Will be removed:/);
  assert.equal(sha(f), before);
  const d = spawnSync(process.execPath, [CLI, 'uninstall', '--dry-run'], { env: { HOME: m.home, USERPROFILE: m.home, PATH: process.env.PATH }, cwd: m.cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  assert.equal(d.status, 0, d.stdout + d.stderr);
  assert.equal(sha(f), before);
});

test('uninstall: removes hooks, the plugin and the wrapped MCP; the vault stays unless confirmed twice', async (t) => {
  const m = machine(t);
  plugin(m);
  install(m, 'codex');
  install(m, 'claude-code');
  const w = wrapped(m);
  const v = vault(m);
  const ran = [];
  const asked = [];
  const c = io(m, {
    envList: w.list, claude: path.resolve('/opt/bin/claude'),
    run: (step) => { ran.push(step.manual); return true; },
    confirm: async (q) => { asked.push(q); return !/vault/i.test(q); },
  });
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.err());
  assert.deepEqual(ran, ['claude plugin uninstall ' + PLUGIN]);
  assert.equal(znHooksIn(path.join(m.home, '.codex', 'hooks.json')), false);
  assert.equal(znHooksIn(settings(m)), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(w.file, 'utf8')), JSON.parse(w.original), 'wrapped MCP config is put back');
  assert.ok(fs.existsSync(v), 'vault kept when the second question is answered no');
  assert.equal(asked.length, 2);
  assert.match(asked[1], /Delete the vault/);
  assert.match(c.out(), /The vault was kept/);
  assert.match(c.out(), /zn-gate check/);
});

test('uninstall: answering no to the first question changes nothing, and the vault is not even offered', async (t) => {
  const m = machine(t);
  install(m, 'codex');
  const v = vault(m);
  const f = path.join(m.home, '.codex', 'hooks.json');
  const before = sha(f);
  const asked = [];
  const c = io(m, { confirm: async (q) => { asked.push(q); return false; } });
  assert.equal(await dispatch('uninstall', [], c.o), 1);
  assert.equal(asked.length, 1);
  assert.equal(sha(f), before);
  assert.ok(fs.existsSync(v));
});

test('uninstall: the vault is deleted after the second confirmation', async (t) => {
  const m = machine(t);
  install(m, 'codex');
  const v = vault(m);
  const c = io(m, { confirm: async () => true });
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.err());
  assert.equal(fs.existsSync(v), false);
  assert.match(c.out(), /Vault deleted/);
});

test('uninstall: only a vault found: it is asked about and kept on no', async (t) => {
  const m = machine(t);
  const v = vault(m);
  const asked = [];
  const c = io(m, { confirm: async (q) => { asked.push(q); return false; } });
  assert.equal(await dispatch('uninstall', [], c.o), 0);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Delete the vault/);
  assert.ok(fs.existsSync(v));
});

test('uninstall: project-scope hooks are removed from the project, user hooks stay when they are not listed', async (t) => {
  const m = machine(t);
  install(m, 'claude-code', 'project');
  const projectFile = path.join(m.cwd, '.claude', 'settings.json');
  assert.ok(znHooksIn(projectFile));
  const c = io(m, { confirm: async () => true });
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.err());
  assert.equal(znHooksIn(projectFile), false);
  assert.match(c.out(), /\(project\)/);
});

test('uninstall: a plugin without a claude command prints the command to type', async (t) => {
  const m = machine(t);
  plugin(m);
  const c = io(m, { confirm: async () => true });
  assert.equal(await dispatch('uninstall', [], c.o), 1); // left for you to do by hand: not a clean run
  assert.match(c.out(), /\/plugin uninstall zn-gate@usezn/);
});

test('uninstall: markers in a .env file are listed and never edited', async (t) => {
  const m = machine(t);
  const env = path.join(m.cwd, '.env');
  fs.writeFileSync(env, 'STRIPE_KEY=__ZN_STRIPE_KEY__\n');
  const before = sha(env);
  const c = io(m, { confirm: async () => true });
  assert.equal(await dispatch('uninstall', [], c.o), 0);
  assert.match(c.out(), /holds zn markers/);
  assert.equal(sha(env), before);
});

test('uninstall: nothing found says so and exits 0; unknown options exit 64', async (t) => {
  const m = machine(t);
  const c = io(m);
  assert.equal(await dispatch('uninstall', [], c.o), 0);
  assert.match(c.out(), /Nothing from zn-gate was found/);
  const d = io(m);
  assert.equal(await dispatch('uninstall', ['--force'], d.o), 64);
  assert.match(d.err(), /unknown option/);
});

test('help lists uninstall and hooks uninstall', () => {
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.match(r.stdout, /^  uninstall {11}/m);
  assert.match(r.stdout, /^  hooks uninstall <agent>/m);
});

// --- exit codes, vault deletion order, re-scan, help ---

test('uninstall: a vault file that cannot be removed keeps the key, is reported, and exits 1', async (t) => {
  const m = machine(t);
  const v = vault(m);
  const keychain = require('../lib/vault/keychain');
  const realUnlink = fs.unlinkSync;
  const realMeta = keychain.readMeta;
  const realDelete = keychain.deleteIdentity;
  let keyDeleted = 0;
  keychain.readMeta = () => ({ backend: 'test' });
  keychain.deleteIdentity = async () => { keyDeleted++; };
  fs.unlinkSync = (f) => { if (f === v) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return realUnlink(f); };
  t.after(() => { fs.unlinkSync = realUnlink; keychain.readMeta = realMeta; keychain.deleteIdentity = realDelete; });
  const c = io(m, { confirm: async () => true });
  assert.equal(await dispatch('uninstall', [], c.o), 1, c.err());
  assert.ok(fs.existsSync(v), 'the file is still there');
  assert.equal(keyDeleted, 0, 'the keychain key is kept');
  assert.ok(c.out().includes(v), 'the file left is named');
  assert.match(c.out(), /key in your system keychain was kept/);
  assert.doesNotMatch(c.out(), /Vault deleted/);
});

test('uninstall: the vault key is removed only after the files are gone', async (t) => {
  const m = machine(t);
  const v = vault(m);
  const keychain = require('../lib/vault/keychain');
  const realMeta = keychain.readMeta;
  const realDelete = keychain.deleteIdentity;
  let fileThere = null;
  keychain.readMeta = () => ({ backend: 'test' });
  keychain.deleteIdentity = async () => { fileThere = fs.existsSync(v); };
  t.after(() => { keychain.readMeta = realMeta; keychain.deleteIdentity = realDelete; });
  const c = io(m, { confirm: async () => true });
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.err());
  assert.equal(fileThere, false);
  assert.match(c.out(), /Vault deleted/);
});

test('uninstall: a hook removal that fails exits 1 and says so', async (t) => {
  const m = machine(t);
  install(m, 'codex');
  const adapter = getAdapter('codex');
  const real = adapter.uninstall;
  adapter.uninstall = () => { throw new Error('settings file is read-only'); };
  t.after(() => { adapter.uninstall = real; });
  const c = io(m, { confirm: async () => true });
  assert.equal(await dispatch('uninstall', [], c.o), 1, c.err());
  assert.match(c.out(), /could not remove the user hooks: settings file is read-only/);
  assert.match(c.out(), /Not everything was removed: 1 step/);
});

test('uninstall: a plugin that is not removed exits 1', async (t) => {
  const m = machine(t);
  plugin(m);
  const c = io(m, { claude: path.resolve('/opt/bin/claude'), run: () => false, confirm: async () => true });
  assert.equal(await dispatch('uninstall', [], c.o), 1, c.err());
  assert.match(c.out(), /the plugin was not removed/);
  const d = io(m, { confirm: async () => true });
  assert.equal(await dispatch('uninstall', [], d.o), 1, 'no claude command: the plugin is left for you to remove');
});

test('uninstall: a server wrapped in a form zn-gate did not write is listed as still wrapped and exits 1', async (t) => {
  const m = machine(t);
  const w = wrapped(m);
  const cfg = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  cfg.mcpServers.odd = { command: 'npx', args: ['-y', 'zn-gate@1.0.0', 'shield', '--', 'uvx', 'x'] };
  fs.writeFileSync(w.file, JSON.stringify(cfg, null, 2));
  const c = io(m, { envList: w.list, confirm: async () => true });
  assert.equal(await dispatch('uninstall', [], c.o), 1, c.err());
  assert.match(c.out(), /original command put back for 1 server/);
  assert.match(c.out(), /Still wrapped by zn-gate shield/);
  assert.ok(c.out().includes('Example MCP (1 server) in ' + w.file));
  assert.equal(JSON.parse(fs.readFileSync(w.file, 'utf8')).mcpServers.fetch.command, 'uvx');
});

test('uninstall: servers added after wrapping stay, and the wrapped ones get their original command back', async (t) => {
  const m = machine(t);
  const w = wrapped(m);
  const cfg = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  cfg.mcpServers.added = { command: 'node', args: ['added.js'] };
  fs.writeFileSync(w.file, JSON.stringify(cfg, null, 2));
  const c = io(m, { envList: w.list, confirm: async () => true });
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.err());
  assert.deepEqual(JSON.parse(fs.readFileSync(w.file, 'utf8')), { mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] }, added: { command: 'node', args: ['added.js'] } } });
});

test('uninstall: a project config that is a symlink is not offered for restore and is skipped', async (t) => {
  const m = machine(t);
  const prev = process.cwd();
  process.chdir(m.cwd);
  try {
    const dir = path.join(fs.realpathSync(m.cwd), '.agents');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'mcp_config.json');
    const original = JSON.stringify({ mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } } }, null, 2);
    fs.writeFileSync(file, original);
    const list = [{ name: 'Antigravity (this project)', id: 'antigravity-project', filePath: file, key: 'mcpServers', format: 'mcpServers-json', scope: 'project' }];
    require('../lib/init').configureEnvironments({ envList: list });
    const shielded = fs.readFileSync(file, 'utf8');
    assert.ok(fs.readdirSync(dir).some((f) => /\.bak\.\d+$/.test(f)));
    const elsewhere = path.join(m.home, 'real-config.json');
    fs.writeFileSync(elsewhere, shielded);
    fs.unlinkSync(file);
    fs.symlinkSync(elsewhere, file);
    const p = await require('../lib/uninstall').plan({ home: m.home, env: m.env, cwd: m.cwd, envList: list });
    assert.equal(p.wrapped.length, 1);
    assert.ok(p.wrapped[0].unsafe);
    const c = io(m, { envList: list, confirm: async () => true });
    assert.equal(await dispatch('uninstall', [], c.o), 1);
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), shielded, 'the linked file is untouched');
    assert.match(c.out(), /cannot be changed safely/);
    assert.match(c.out(), /Still wrapped by zn-gate shield/);
  } finally { process.chdir(prev); }
});

test('uninstall: a clean run with everything removed exits 0 and prints no leftovers', async (t) => {
  const m = machine(t);
  install(m, 'codex');
  const w = wrapped(m);
  const c = io(m, { envList: w.list, confirm: async () => true });
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.err());
  assert.doesNotMatch(c.out(), /Still wrapped|Not everything was removed/);
});

test('uninstall --help and -h print the uninstall help, not the general help', () => {
  for (const flag of ['--help', '-h']) {
    const r = spawnSync(process.execPath, [CLI, 'uninstall', flag], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^usage: zn-gate uninstall \[--dry-run\]/m);
    assert.doesNotMatch(r.stdout, /hooks install/);
  }
});

test('uninstall: plan looks at the project folder it is given, not the process working folder', async (t) => {
  const m = machine(t);
  const other = tempDir(t, 'zn-uninst-other-');
  assert.notEqual(fs.realpathSync(other), fs.realpathSync(process.cwd()));
  const keep = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG: process.env.XDG_CONFIG_HOME, CODEX: process.env.CODEX_HOME };
  process.env.HOME = m.home; process.env.USERPROFILE = m.home; delete process.env.XDG_CONFIG_HOME; delete process.env.CODEX_HOME;
  try {
    const init = require('../lib/init');
    const dir = path.join(fs.realpathSync(m.cwd), '.agents');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'mcp_config.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } } }, null, 2));
    const envList = init.getKnownEnvironments(fs.realpathSync(m.cwd)).filter((e) => e.id === 'antigravity-project');
    assert.equal(envList[0].filePath, file);
    init.configureEnvironments({ envList, projectDir: fs.realpathSync(m.cwd) });
    const u = require('../lib/uninstall');
    const p = await u.plan({ home: m.home, env: m.env, cwd: fs.realpathSync(m.cwd) });
    const hit = p.wrapped.filter((w) => w.file === file);
    assert.equal(hit.length, 1, 'the project config of the given folder is listed');
    assert.equal(hit[0].unsafe, null, 'and it is safe to restore');
    const elsewhere = await u.plan({ home: m.home, env: m.env, cwd: other });
    assert.equal(elsewhere.wrapped.filter((w) => w.file === file).length, 0, 'another folder does not see it');
  } finally {
    for (const [k, v] of [['HOME', keep.HOME], ['USERPROFILE', keep.USERPROFILE], ['XDG_CONFIG_HOME', keep.XDG], ['CODEX_HOME', keep.CODEX]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
