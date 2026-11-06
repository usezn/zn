'use strict';

// zn-gate uninstall, per agent: the plan names each agent and its file, and a confirmed run removes
// that agent's hooks for the user and for the project. Everything runs in temporary folders.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { dispatch } = require('../lib/broker/cli');
const uninstall = require('../lib/uninstall');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const AGENTS = [
  ['claude-code', 'Claude Code'],
  ['codex', 'Codex CLI'],
  ['cursor', 'Cursor'],
  ['opencode', 'OpenCode'],
  ['antigravity', 'Antigravity'],
  ['copilot', null],
  ['gemini', null],
];

function machine(t) {
  const home = tempDir(t, 'zn-uninst-agent-home-');
  const cwd = tempDir(t, 'zn-uninst-agent-cwd-');
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

function install(m, id, scope) {
  return getAdapter(id).install({
    scope, projectDir: m.cwd, home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false,
  });
}

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

// OpenCode is covered by the project-scope test below.
for (const [id, label] of AGENTS.filter(([id]) => id !== 'opencode')) {
  test('uninstall: ' + id + ' user hooks are planned and then removed', async (t) => {
    const m = machine(t);
    const rep = install(m, id, 'user');
    const file = rep.settings;
    assert.ok(file && fs.existsSync(file), 'the install wrote a file');
    const p = await uninstall.plan({ home: m.home, env: m.env, cwd: m.cwd, envList: [] });
    const a = p.agents.find((x) => x.id === id);
    assert.ok(a, 'the agent is in the plan');
    assert.equal(a.userHooks, file);
    assert.equal(a.projectHooks, null);
    if (label) assert.equal(a.name, label);
    const dry = io(m);
    assert.equal(await dispatch('uninstall', ['--dry-run'], dry.o), 0);
    assert.ok(dry.out().includes(file));
    assert.ok(dry.out().includes('  ' + a.name + '\n'));
    const before = read(file);
    assert.ok(before.length > 0);
    const c = io(m, { confirm: async () => true });
    assert.equal(await dispatch('uninstall', [], c.o), 0, c.out() + c.err());
    assert.ok(c.out().includes('removed zn\'s hooks (user) in '), c.out());
    const after = await uninstall.plan({ home: m.home, env: m.env, cwd: m.cwd, envList: [] });
    assert.equal(after.agents.find((x) => x.id === id), undefined, 'nothing left to remove');
  });
}

test('uninstall: other agents are left alone when only one is set up', async (t) => {
  const m = machine(t);
  install(m, 'codex', 'user');
  const p = await uninstall.plan({ home: m.home, env: m.env, cwd: m.cwd, envList: [] });
  assert.deepEqual(p.agents.map((a) => a.id), ['codex']);
});

test('uninstall: project hooks of codex, cursor and opencode are planned and removed', async (t) => {
  const m = machine(t);
  const files = ['codex', 'cursor', 'opencode'].map((id) => install(m, id, 'project').settings);
  const p = await uninstall.plan({ home: m.home, env: m.env, cwd: m.cwd, envList: [] });
  for (const id of ['codex', 'cursor', 'opencode']) {
    const a = p.agents.find((x) => x.id === id);
    assert.ok(a, id + ' is planned');
    assert.equal(a.userHooks, null);
    assert.ok(files.includes(a.projectHooks));
  }
  const c = io(m, { confirm: async () => true });
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out() + c.err());
  assert.equal((c.out().match(/removed zn's hooks \(project\)/g) || []).length, 3);
  assert.equal(files.some((f) => fs.existsSync(f) && /runner\.js/.test(read(f))), false);
  const after = await uninstall.plan({ home: m.home, env: m.env, cwd: m.cwd, envList: [] });
  assert.deepEqual(after.agents, []);
});

test('uninstall: user and project hooks of one agent are both removed', async (t) => {
  const m = machine(t);
  install(m, 'codex', 'user');
  install(m, 'codex', 'project');
  const c = io(m, { confirm: async () => true });
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out() + c.err());
  assert.match(c.out(), /Codex CLI: removed zn's hooks \(user\)/);
  assert.match(c.out(), /Codex CLI: removed zn's hooks \(project\)/);
});

test('uninstall: a hooks file with other settings keeps them', async (t) => {
  const m = machine(t);
  const file = install(m, 'claude-code', 'user').settings;
  const tree = JSON.parse(read(file));
  tree.theme = 'example-theme';
  fs.writeFileSync(file, JSON.stringify(tree));
  const c = io(m, { confirm: async () => true });
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out() + c.err());
  assert.equal(JSON.parse(read(file)).theme, 'example-theme');
});

test('uninstall: the confirmation question is asked once for the removal and mentions the list', async (t) => {
  const m = machine(t);
  install(m, 'codex', 'user');
  const asked = [];
  const c = io(m, { confirm: async (q) => { asked.push(q); return true; } });
  assert.equal(await dispatch('uninstall', [], c.o), 0);
  assert.deepEqual(asked, ['Remove what is listed above?']);
  assert.match(c.out(), /Last step, to remove the program itself: npm uninstall -g zn-gate/);
});

test('uninstall: declining leaves every agent file as it was and says nothing was changed', async (t) => {
  const m = machine(t);
  const files = ['codex', 'cursor', 'claude-code'].map((id) => install(m, id, 'user').settings);
  const before = files.map(read);
  const c = io(m, { confirm: async () => false });
  assert.equal(await dispatch('uninstall', [], c.o), 1);
  assert.match(c.out(), /Nothing was changed\./);
  assert.deepEqual(files.map(read), before);
});

test('uninstall: the plan lists .env.local markers and ignores files without markers', async (t) => {
  const m = machine(t);
  fs.writeFileSync(path.join(m.cwd, '.env.local'), 'EXAMPLE_TOKEN=__ZN_EXAMPLE_TOKEN__\n');
  fs.writeFileSync(path.join(m.cwd, '.env.plain'), 'EXAMPLE_TOKEN=not-a-marker\n');
  fs.writeFileSync(path.join(m.cwd, 'notes.env'), 'EXAMPLE_TOKEN=__ZN_EXAMPLE_TOKEN__\n');
  const p = await uninstall.plan({ home: m.home, env: m.env, cwd: m.cwd, envList: [] });
  assert.deepEqual(p.shadowed, [path.join(m.cwd, '.env.local')]);
});

test('uninstall: a vault and shadowed files get the extra sentence in the second question flow', async (t) => {
  const m = machine(t);
  fs.mkdirSync(path.join(m.home, '.zn', 'vault'), { recursive: true });
  fs.writeFileSync(path.join(m.home, '.zn', 'vault', 'secrets.age'), 'not a real vault\n');
  fs.writeFileSync(path.join(m.cwd, '.env'), 'EXAMPLE_TOKEN=__ZN_EXAMPLE_TOKEN__\n');
  const c = io(m, { confirm: async () => false });
  assert.equal(await dispatch('uninstall', [], c.o), 0);
  assert.match(c.out(), /The \.env files with markers need it\./);
  assert.match(c.out(), /The vault was kept\./);
});

test('uninstall: an extra argument is a usage error', async (t) => {
  const m = machine(t);
  const c = io(m);
  assert.equal(await dispatch('uninstall', ['now'], c.o), 64);
  assert.match(c.err(), /unexpected argument/);
});
