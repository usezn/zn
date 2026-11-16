// Tests of check-docs-code-trailing-space.mjs. Run: node --test .github/scripts/check-docs-code-trailing-space.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkDir, trailingSpaceInCode } from './check-docs-code-trailing-space.mjs';

test('clean code blocks pass', () => {
  assert.deepEqual(trailingSpaceInCode('# T\n\n```sh\necho hi\n```\n'), []);
});

test('a trailing space inside a fenced block is reported with its line', () => {
  assert.deepEqual(trailingSpaceInCode('# T\n\n```sh\necho hi \n```\n'), [4]);
});

test('a tab and a whitespace-only line inside a block count', () => {
  assert.deepEqual(trailingSpaceInCode('```\na\t\n   \nb\n```\n'), [2, 3]);
});

test('trailing spaces outside code are not this check (markdownlint MD009 covers them)', () => {
  assert.deepEqual(trailingSpaceInCode('Text.   \n\n```\nx\n```\n'), []);
});

test('a CRLF ending is not trailing whitespace', () => {
  assert.deepEqual(trailingSpaceInCode('```\r\necho hi\r\n```\r\n'), []);
});

test('a longer closing fence ends the block, a shorter one does not', () => {
  assert.deepEqual(trailingSpaceInCode('````\n```\nx \n````\ny \n'), [3]);
});

test('a tilde fence is a code block too', () => {
  assert.deepEqual(trailingSpaceInCode('~~~\nx \n~~~\n'), [2]);
});

test('checkDir covers docs/**/*.md and README.md only', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'code-trailing-'));
  try {
    fs.mkdirSync(path.join(root, 'docs', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'a.md'), '```\nx \n```\n');
    fs.writeFileSync(path.join(root, 'docs', 'sub', 'b.md'), '```\nok\n```\n');
    fs.writeFileSync(path.join(root, 'README.md'), '```\nok\n```\n');
    fs.writeFileSync(path.join(root, 'packages', 'c.md'), '```\nx \n```\n');
    fs.writeFileSync(path.join(root, 'docs', 'notes.txt'), '```\nx \n```\n');
    const { checked, problems } = checkDir(root);
    assert.equal(checked, 3);
    assert.deepEqual(problems, [{ file: 'docs/a.md', line: 2 }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
