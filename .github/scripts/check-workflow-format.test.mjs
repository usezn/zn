// Tests of check-workflow-format.mjs. Run: node --test .github/scripts/check-workflow-format.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkDir, findFormatProblems } from './check-workflow-format.mjs';

test('a file with two-space steps and a final newline passes', () => {
  assert.deepEqual(findFormatProblems('name: x\non: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo hi\n'), []);
});

test('a tab is named with its line', () => {
  assert.deepEqual(findFormatProblems('jobs:\n\ta:\n'), [{ line: 2, reason: 'tab character (indent with spaces)' }]);
});

test('a tab inside the content of a line is named too', () => {
  assert.deepEqual(findFormatProblems('a: "x\ty"\n'), [{ line: 1, reason: 'tab character (indent with spaces)' }]);
});

test('an odd leading indent is named with its line', () => {
  assert.deepEqual(findFormatProblems('jobs:\n   a:\n'), [{ line: 2, reason: 'indented by 3 spaces, not a multiple of 2' }]);
});

test('a blank line with odd spaces is not an indent', () => {
  assert.deepEqual(findFormatProblems('a: 1\n   \nb: 2\n'), []);
});

test('a file without a final newline is named at its last line', () => {
  assert.deepEqual(findFormatProblems('name: x\non: push'), [{ line: 2, reason: 'no newline at the end of the file' }]);
});

test('an empty file is named', () => {
  assert.deepEqual(findFormatProblems(''), [{ line: 1, reason: 'empty file' }]);
});

test('several problems come out in line order', () => {
  assert.deepEqual(
    findFormatProblems('a:\n b: 1\n\tc: 2\nd: 3'),
    [
      { line: 2, reason: 'indented by 1 spaces, not a multiple of 2' },
      { line: 3, reason: 'tab character (indent with spaces)' },
      { line: 4, reason: 'no newline at the end of the file' },
    ],
  );
});

test('checkDir reads the .yml and .yaml files of a folder', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'wfformat-'));
  try {
    fs.writeFileSync(path.join(dir, 'ok.yml'), 'name: x\n');
    fs.writeFileSync(path.join(dir, 'bad.yaml'), 'jobs:\n   a: 1\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored\t');
    const r = checkDir(dir);
    assert.equal(r.checked, 2);
    assert.deepEqual(r.problems, [{ file: 'bad.yaml', line: 2, reason: 'indented by 3 spaces, not a multiple of 2' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
