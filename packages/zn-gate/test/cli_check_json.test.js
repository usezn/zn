'use strict';

// zn-gate check --json prints one JSON object built from check()'s data, with the same exit codes as the text form.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getAdapter } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const VERSION = require('../package.json').version;

function ctx(t) {
  const home = tempDir(t, 'zn-cj-home-');
  return { home, cwd: tempDir(t, 'zn-cj-cwd-'), env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, ZN_STATS: 'off' } };
}

function setUp(t) {
  const c = ctx(t);
  getAdapter('claude-code').install({ scope: 'user', home: c.home, env: c.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  return c;
}

function run(c, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: c.cwd, env: c.env, encoding: 'utf8', timeout: 120000 });
}

const FIELDS = ['agents', 'exit_code', 'node_version', 'project_rules_errors', 'protected', 'schema', 'test_folder_removed', 'warnings', 'zn_gate_version'];
const AGENT_FIELDS = ['checked', 'fix', 'id', 'message', 'name', 'notes', 'protected', 'reason', 'state'];

test('check --json: an unprotected home gives one object and exit 1, like the text form', (t) => {
  const c = ctx(t);
  const r = run(c, ['check', '--json']);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(j).sort(), FIELDS);
  assert.equal(j.schema, 1);
  assert.equal(j.zn_gate_version, VERSION);
  assert.equal(j.protected, false);
  assert.equal(j.exit_code, 1);
  assert.equal(r.status, 1);
  assert.equal(run(c, ['check']).status, 1);
  for (const a of j.agents) {
    assert.deepEqual(Object.keys(a).sort(), AGENT_FIELDS);
    assert.equal(a.protected, false);
  }
  assert.ok(j.agents.some((a) => a.id === 'claude-code'));
});

test('check --json: a protected home exits 0 and lists the agent as protected', (t) => {
  const c = setUp(t);
  const r = run(c, ['doctor', '--json']);
  const j = JSON.parse(r.stdout);
  assert.equal(r.status, 0);
  assert.equal(run(c, ['check']).status, 0);
  assert.equal(j.exit_code, 0);
  assert.equal(j.protected, true);
  const a = j.agents.find((x) => x.id === 'claude-code');
  assert.equal(a.state, 'protected');
  assert.equal(a.protected, true);
  assert.equal(a.reason, '');
  assert.ok(a.message.length > 0);
});

test('check --json: stdout is only the JSON and the home folder is replaced with ~', (t) => {
  const c = setUp(t);
  fs.writeFileSync(path.join(c.home, '.codex'), 'not a folder');
  const r = run(c, ['check', '--json']);
  assert.ok(r.stdout.startsWith('{') && r.stdout.trimEnd().endsWith('}'));
  const j = JSON.parse(r.stdout);
  assert.ok(!r.stdout.includes(c.home), 'home path leaked');
  assert.ok(!r.stdout.includes(fs.realpathSync(c.home)), 'real home path leaked');
  assert.ok(j.agents.length > 1);
});

test('check --json: valid JSON and exit 1 when an agent config is malformed', (t) => {
  const c = setUp(t);
  fs.writeFileSync(path.join(c.home, '.claude', 'settings.json'), '{ this is not json');
  const r = run(c, ['check', '--json']);
  const j = JSON.parse(r.stdout);
  assert.equal(r.status, 1);
  const a = j.agents.find((x) => x.id === 'claude-code');
  assert.equal(a.protected, false);
  assert.notEqual(a.state, 'protected');
  assert.equal(run(c, ['check']).status, 1);
  assert.ok(!r.stdout.includes(c.home));
});

// Skipped on Windows: the nested path reuses an absolute path (a drive letter cannot sit inside a path component)
// and symlinkSync needs extra privileges there. The replacement logic is the same on every platform.
test('toJson hides a home whose real path contains it (longest form replaced first)', { skip: process.platform === 'win32' }, () => {
  const fsm = require('node:fs');
  const osm = require('node:os');
  const pathm = require('node:path');
  const { toJson } = require('../lib/check.js');
  const base = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'zn-home-'));
  try {
    // real: <base>/private<base>/home ; link: <base>/home -> real. The link path is a substring of the real path.
    const real = pathm.join(base, 'private' + base, 'home');
    fsm.mkdirSync(real, { recursive: true });
    const link = pathm.join(base, 'home');
    fsm.symlinkSync(real, link);
    const realHome = fsm.realpathSync(link);
    const out = toJson({
      results: [{ id: 'codex', name: 'Codex CLI', state: 'not-set-up', found: true, problem: 'missing ' + realHome + '/.codex/hooks.json', fix: 'edit ' + link + '/.codex' }],
      removed: [],
      warnings: ['see ' + realHome + '/x'],
    }, { home: link, version: '0.0.0' });
    const text = JSON.stringify(out);
    assert.ok(!text.includes(base), text);
    assert.equal(out.agents[0].reason, 'missing ~/.codex/hooks.json');
    assert.equal(out.agents[0].fix, 'edit ~/.codex');
    assert.equal(out.warnings[0], 'see ~/x');
  } finally {
    fsm.rmSync(base, { recursive: true, force: true });
  }
});

test('check --hooks --json is refused with exit 2', () => {
  const cli = path.join(__dirname, '..', 'bin', 'cli.js');
  for (const cmd of ['check', 'doctor']) {
    const r = spawnSync(process.execPath, [cli, cmd, '--hooks', '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /--hooks and --json cannot be used together/);
  }
});
