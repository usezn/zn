'use strict';

// zn-gate check --json lists every supported agent id (the ids exported by the adapter registry).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { AGENT_IDS } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

test('check --json lists every supported agent id', (t) => {
  const home = tempDir(t, 'zn-cj-ids-home-');
  const cwd = tempDir(t, 'zn-cj-ids-cwd-');
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH, ZN_STATS: 'off' };
  const r = spawnSync(process.execPath, [CLI, 'check', '--json'], { cwd, env, encoding: 'utf8', timeout: 120000 });
  const j = JSON.parse(r.stdout);
  const listed = new Set(j.agents.map((a) => a.id));
  assert.ok(AGENT_IDS.length > 0, 'the agent registry exports no ids');
  for (const id of AGENT_IDS) {
    assert.ok(listed.has(id), `check --json does not list agent "${id}"`);
  }
});

// uninstall reads an internal marker to find the OpenCode plugin; it is not part of what check prints.
test('check output for an OpenCode plugin install carries no via field', (t) => {
  const { getAdapter } = require('../lib/agents');
  const home = tempDir(t, 'zn-cj-oc-home-');
  const cwd = tempDir(t, 'zn-cj-oc-cwd-');
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH, ZN_STATS: 'off' };
  getAdapter('opencode').install({ scope: 'user', projectDir: cwd, home, env, nodePath: process.execPath, runnerPath: path.join(__dirname, '..', 'lib', 'hooks', 'runner.js'), mcp: false });
  const r = spawnSync(process.execPath, [CLI, 'check', '--json'], { cwd, env, encoding: 'utf8', timeout: 120000 });
  const j = JSON.parse(r.stdout);
  const oc = j.agents.find((a) => a.id === 'opencode');
  assert.ok(oc, 'opencode is listed');
  assert.equal(Object.prototype.hasOwnProperty.call(oc, 'via'), false, 'no via field is printed');
  assert.deepEqual(Object.keys(oc).sort(), ['checked', 'fix', 'id', 'message', 'name', 'notes', 'protected', 'reason', 'state']);
  const h = spawnSync(process.execPath, [CLI, 'check'], { cwd, env, encoding: 'utf8', timeout: 120000 });
  assert.doesNotMatch(h.stdout, /\bvia\b/);
});
