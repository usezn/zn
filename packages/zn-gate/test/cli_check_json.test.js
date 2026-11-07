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
