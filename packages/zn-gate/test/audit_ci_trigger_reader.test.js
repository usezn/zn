'use strict';

// ZNA019 reads the triggers of a workflow from its `on:` block: a key of `permissions:` that has the name of a trigger is not one.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { audit } = require('../lib/audit');
const { tempDir } = require('./helpers/tmp');

function run(t, lines) {
  const dir = tempDir(t, 'zn-ci-trigger-');
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'agent.yml'), lines.join('\n') + '\n');
  return audit({ root: dir, agents: ['all'], env: {} }).findings.filter((f) => f.id === 'ZNA019');
}

const JOB = ['jobs:', '  run:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: anthropics/claude-code-action@v1', '        with:', '          prompt: "${{ github.event.comment.body }}"'];

test('issues: write under permissions is not the issues trigger', (t) => {
  const f = run(t, ['name: agent', 'on:', '  issue_comment:', '    types: [created]', 'permissions:', '  issues: write', '  contents: read', ...JOB]);
  assert.equal(f.length, 1);
  assert.match(f[0].detail, /triggered by issue_comment[;.]/);
  assert.ok(!/issue_comment, issues/.test(f[0].detail), f[0].detail);
});

test('a workflow whose only trigger is pull_request is not flagged because of a permissions key', (t) => {
  assert.deepEqual(run(t, ['name: agent', 'on:', '  pull_request:', 'permissions:', '  issues: write', '  discussions: write', ...JOB]), []);
});

test('the issues trigger is still read in every spelling of the on block', (t) => {
  for (const on of [['on:', '  issues:', '    types: [opened]'], ['on: [issues, push]'], ['on: issues'], ['on:', '  push:', '  issues:', '    types: [opened]'], ['"on":', '  issues:']]) {
    const f = run(t, ['name: agent', ...on, 'permissions:', '  issues: write', ...JOB]);
    assert.equal(f.length, 1, on.join(' | '));
    assert.match(f[0].detail, /triggered by issues[;.]/, on.join(' | '));
  }
});

test('a workflow with no on: block is read as before', (t) => {
  const f = run(t, ['name: agent', 'permissions:', '  contents: read', ...JOB]);
  assert.deepEqual(f, []);
});
