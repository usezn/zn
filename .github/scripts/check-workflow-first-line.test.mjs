// Tests of check-workflow-first-line.mjs. Run: node --test .github/scripts/check-workflow-first-line.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkDir, firstLineProblem, MAX_LENGTH } from './check-workflow-first-line.mjs';

test('a workflow that starts with a comment passes', () => {
  assert.equal(firstLineProblem('# Runs the checks on every pull request.\nname: Checks\n'), null);
});

test('a byte order mark before the comment is allowed', () => {
  assert.equal(firstLineProblem('﻿# Runs the checks.\nname: Checks\n'), null);
});

test('a first line that is not a comment fails, even when a comment comes later', () => {
  assert.notEqual(firstLineProblem('name: Checks\n# Runs the checks.\n'), null);
  assert.notEqual(firstLineProblem('\n# Runs the checks.\nname: Checks\n'), null);
});

test('a comment without a space after the hash, or an empty comment, fails', () => {
  assert.notEqual(firstLineProblem('#Runs the checks.\nname: Checks\n'), null);
  assert.notEqual(firstLineProblem('#\nname: Checks\n'), null);
  assert.notEqual(firstLineProblem('# \nname: Checks\n'), null);
});

test('a comment longer than the limit fails', () => {
  assert.equal(firstLineProblem('# ' + 'a'.repeat(MAX_LENGTH - 2) + '\n'), null);
  assert.notEqual(firstLineProblem('# ' + 'a'.repeat(MAX_LENGTH - 1) + '\n'), null);
});

test('an empty file fails', () => {
  assert.notEqual(firstLineProblem(''), null);
});

function tree(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'wfirstline-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('checkDir reports each workflow without a comment and skips other files', () => {
  const dir = tree({
    'a.yml': '# Good.\nname: A\n',
    'b.yaml': 'name: B\n',
    'notes.txt': 'no comment here',
  });
  const r = checkDir(dir);
  assert.equal(r.checked, 2);
  assert.deepEqual(r.problems.map((p) => p.file), ['b.yaml']);
});
