// Tests of check-docs-fences.mjs. Run: node --test .github/scripts/check-docs-fences.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkDir, unclosedFenceLine } from './check-docs-fences.mjs';

test('closed fences pass', () => {
  assert.equal(unclosedFenceLine('a\n```sh\nzn init\n```\nb\n'), null);
  assert.equal(unclosedFenceLine('~~~text\nx\n~~~\n'), null);
  assert.equal(unclosedFenceLine('```sh\na\n```\n```json\nb\n```\n'), null);
});

test('a fence still open at the end of the text is reported at its opening line', () => {
  assert.equal(unclosedFenceLine('# T\n\n```sh\necho hi\n'), 3);
});

test('the closing fence must use the same character and at least as many', () => {
  assert.equal(unclosedFenceLine('~~~\nx\n```\n'), 1);
  assert.equal(unclosedFenceLine('````md\n```\nx\n````\n'), null);
  assert.equal(unclosedFenceLine('````md\n```\n```\n'), 1);
});

test('text after the closing characters does not close the fence', () => {
  assert.equal(unclosedFenceLine('```sh\nzn init\n``` done\n'), 1);
});

test('an info string with a backtick is inline code, not a fence', () => {
  assert.equal(unclosedFenceLine('Use ```zn init``` here.\n'), null);
});

test('checkDir lists the unclosed pages with their line', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'docfences-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\n```sh\nzn init\n```\n');
    fs.writeFileSync(path.join(dir, 'sub', 'b.md'), '# B\n\n```sh\nzn init\n');
    const r = checkDir(dir);
    assert.equal(r.checked, 2);
    assert.equal(r.problems.length, 1);
    assert.ok(r.problems[0].file.endsWith('sub/b.md'));
    assert.equal(r.problems[0].line, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
