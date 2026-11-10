'use strict';

// zn-gate check --json on an empty home folder: two runs give the same top-level and per-agent key names, and the
// agent ids are the fixed list that lib/check.js defines.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { AGENTS } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const TOP_KEYS = ['agents', 'exit_code', 'node_version', 'project_rules_errors', 'protected', 'schema', 'test_folder_removed', 'warnings', 'zn_gate_version'];
const AGENT_KEYS = ['checked', 'fix', 'id', 'message', 'name', 'notes', 'protected', 'reason', 'state'];
const AGENT_IDS = ['antigravity', 'claude-code', 'codex', 'copilot', 'cursor', 'gemini', 'opencode', 'zcode'];

// A fresh, empty home for each run.
function checkJsonOnEmptyHome(t) {
  const home = tempDir(t, 'zn-cjh-home-');
  const cwd = tempDir(t, 'zn-cjh-cwd-');
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH, ZN_STATS: 'off' };
  const r = spawnSync(process.execPath, [CLI, 'check', '--json'], { cwd, env, encoding: 'utf8', timeout: 120000 });
  return { status: r.status, json: JSON.parse(r.stdout) };
}

const agentIds = (j) => j.agents.map((a) => a.id).sort();

test('check --json on an empty home: same top-level and agent key names on two runs', (t) => {
  const a = checkJsonOnEmptyHome(t);
  const b = checkJsonOnEmptyHome(t);
  assert.deepEqual(Object.keys(a.json).sort(), TOP_KEYS);
  assert.deepEqual(Object.keys(b.json).sort(), TOP_KEYS);
  for (const j of [a.json, b.json]) {
    assert.ok(j.agents.length > 0);
    for (const agent of j.agents) assert.deepEqual(Object.keys(agent).sort(), AGENT_KEYS);
  }
  assert.equal(a.status, b.status);
});

test('check --json on an empty home lists the fixed agent ids on both runs', (t) => {
  const a = checkJsonOnEmptyHome(t);
  const b = checkJsonOnEmptyHome(t);
  assert.deepEqual(agentIds(a.json), AGENT_IDS);
  assert.deepEqual(agentIds(b.json), agentIds(a.json));
  assert.deepEqual(AGENTS.map((g) => g.id).sort(), AGENT_IDS);
});
