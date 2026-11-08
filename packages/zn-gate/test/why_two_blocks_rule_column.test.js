'use strict';

// `zn why` with two blocks in the log. It explains one block (the last one, or the record with a given id) and
// shows its rule id on the Rule line. It does not print a table of blocks with a rule id column.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { logEvidence } = require('../lib/evidence');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function setup(t) {
  const home = tempDir(t, 'zn-why-two-');
  const file = path.join(home, '.zn', 'evidence.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { home, file };
}

function why(home, args) {
  return spawnSync(process.execPath, [CLI, 'why', ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', ZN_HOME: '' },
  });
}

function hookBlock(file, rule) {
  return logEvidence({
    agent: 'claude-code', phase: 'hook-pre_tool', tool_name: 'Bash',
    payload: JSON.stringify({ event: 'pre_tool', tool: 'Bash', kinds: ['aws_access_key'] }),
    verdict: 'block', rule, reason: 'secret kinds: aws_access_key', engine: 'zn-hook',
  }, file, { noStats: true, _plainPreview: true });
}

test('with two blocks, zn why explains the last one and names its rule id', (t) => {
  const { home, file } = setup(t);
  const first = hookBlock(file, 'hook-pre_tool-policy');
  const last = hookBlock(file, 'hook-pre_tool-secret');
  const r = why(home, []);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(last.id));
  assert.match(r.stdout, /^ {2}Rule: {4}hook-pre_tool-secret/m);
  assert.doesNotMatch(r.stdout, new RegExp(first.id));
  assert.doesNotMatch(r.stdout, /hook-pre_tool-policy/);
});

test('zn why lists every block with its rule id in a column',
  { todo: 'premise false: zn why explains one block (the last, or the one given by id) and has no list or rule id column' },
  (t) => {
    const { home, file } = setup(t);
    hookBlock(file, 'hook-pre_tool-policy');
    hookBlock(file, 'hook-pre_tool-secret');
    const r = why(home, []);
    assert.match(r.stdout, /hook-pre_tool-policy/);
    assert.match(r.stdout, /hook-pre_tool-secret/);
  });
