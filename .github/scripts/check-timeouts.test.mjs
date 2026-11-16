// Tests of check-timeouts.mjs. Run: node --test .github/scripts/check-timeouts.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkDir, findMissingTimeouts } from './check-timeouts.mjs';

const wf = (jobs) => `name: x\non: push\njobs:\n${jobs}`;

test('every job with a timeout passes', () => {
  const text = wf('  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps: []\n  b:\n    timeout-minutes: 5\n    runs-on: ubuntu-latest\n');
  assert.deepEqual(findMissingTimeouts(text), []);
});

test('a job without a timeout is named', () => {
  const text = wf('  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n');
  assert.deepEqual(findMissingTimeouts(text), [{ job: 'b', reason: 'no timeout-minutes' }]);
});

test('a timeout-minutes on a step does not count for the job', () => {
  const text = wf('  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n        timeout-minutes: 5\n');
  assert.equal(findMissingTimeouts(text).length, 1);
});

test('the last job of the file is checked too', () => {
  const text = wf('  a:\n    timeout-minutes: 3\n  last:\n    runs-on: ubuntu-latest\n');
  assert.deepEqual(findMissingTimeouts(text).map((p) => p.job), ['last']);
});

test('a job that calls a reusable workflow is skipped', () => {
  const text = wf('  build:\n    uses: ./.github/workflows/build.yml\n    with:\n      x: 1\n');
  assert.deepEqual(findMissingTimeouts(text), []);
});

test('keys after the jobs block and comments do not count as jobs', () => {
  const text = wf('  # a comment\n  a:\n    timeout-minutes: 3\n') + 'env:\n  other:\n    x: 1\n';
  assert.deepEqual(findMissingTimeouts(text), []);
});

test('a file without jobs passes, a jobs block it cannot read fails', () => {
  assert.deepEqual(findMissingTimeouts('name: x\non: push\n'), []);
  assert.equal(findMissingTimeouts('jobs:\n    a:\n        timeout-minutes: 3\n').length, 1);
});

test('a job written in flow style cannot hide a missing timeout', () => {
  const text = wf('  a:\n    timeout-minutes: 3\n    runs-on: x\n  b: { runs-on: ubuntu-latest }\n');
  const problems = findMissingTimeouts(text);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].job, 'b');
  assert.match(problems[0].reason, /block form/);
});

test('an inline jobs value cannot hide a missing timeout', () => {
  const text = 'name: x\non: push\njobs: { build: { runs-on: ubuntu-latest } }\n';
  const problems = findMissingTimeouts(text);
  assert.notEqual(problems.length, 0);
  assert.equal(problems[0].job, '(file)');
  assert.match(problems[0].reason, /inline value/);
});

test('a jobs key with only a comment after it is still read in block form', () => {
  const text = wf('  a:\n    runs-on: x\n    timeout-minutes: 3\n').replace('jobs:\n', 'jobs: # all jobs\n');
  assert.deepEqual(findMissingTimeouts(text), []);
});

test('a job key with a quoted name is still checked', () => {
  const text = wf('  "a":\n    runs-on: x\n');
  assert.deepEqual(findMissingTimeouts(text), [{ job: 'a', reason: 'no timeout-minutes' }]);
});

test('checkDir reads every workflow file of a folder', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'timeouts-'));
  try {
    fs.writeFileSync(path.join(dir, 'ok.yml'), wf('  a:\n    timeout-minutes: 3\n'));
    fs.writeFileSync(path.join(dir, 'bad.yaml'), wf('  a:\n    runs-on: x\n'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    const r = checkDir(dir);
    assert.equal(r.checked, 2);
    assert.deepEqual(r.problems, [{ file: 'bad.yaml', job: 'a', reason: 'no timeout-minutes' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
