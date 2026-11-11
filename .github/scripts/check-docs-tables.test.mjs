// Tests of check-docs-tables.mjs. Run: node --test .github/scripts/check-docs-tables.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkFiles, findBadRows, splitCells } from './check-docs-tables.mjs';

test('splitCells counts cells with and without outer pipes', () => {
  assert.equal(splitCells('| a | b |').length, 2);
  assert.equal(splitCells('a | b').length, 2);
  assert.equal(splitCells('| a |').length, 1);
  assert.equal(splitCells('| a | |').length, 2);
});

test('an escaped pipe is text, not a separator', () => {
  assert.deepEqual(splitCells('| a \\| b | c |'), ['a \\| b', 'c']);
});

test('a pipe inside an inline code span is text', () => {
  assert.deepEqual(splitCells('| `a|b` | c |'), ['`a|b`', 'c']);
  assert.deepEqual(splitCells('| ``a`|`b`` | c |'), ['``a`|`b``', 'c']);
});

test('a backtick run without a closing run is literal', () => {
  assert.equal(splitCells('| `a | b |').length, 2);
});

test('a well-formed table passes', () => {
  assert.deepEqual(findBadRows('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | |\n'), []);
});

test('a row with too few cells is named with its line', () => {
  assert.deepEqual(
    findBadRows('# T\n\n| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n'),
    [{ line: 5, cells: 2, expected: 3 }],
  );
});

test('a row with too many cells is named with its line', () => {
  assert.deepEqual(findBadRows('| a | b |\n|---|---|\n| 1 | 2 | 3 |\n'), [{ line: 3, cells: 3, expected: 2 }]);
});

test('escaped pipes and pipes in code do not change the count', () => {
  assert.deepEqual(findBadRows('| a \\| b | `c|d` |\n|---|---|\n| x \\| y | `z|w` |\n'), []);
});

test('a delimiter row with another width is named', () => {
  assert.deepEqual(findBadRows('| a | b |\n|---|---|---|\n| 1 | 2 |\n'), [{ line: 2, cells: 3, expected: 2 }]);
});

test('tables inside fenced code blocks are ignored', () => {
  assert.deepEqual(findBadRows('```md\n| a | b |\n|---|\n| 1 |\n```\n'), []);
  assert.deepEqual(findBadRows('~~~\n| a | b |\n|---|---|\n| 1 |\n~~~\n'), []);
});

test('an indented fence inside a list item is skipped too', () => {
  assert.deepEqual(findBadRows('- item\n\n  ```\n  | a | b |\n  |---|---|\n  | 1 |\n  ```\n'), []);
});

test('the table ends at a blank line, so text after it is not a row', () => {
  assert.deepEqual(findBadRows('| a | b |\n|---|---|\n| 1 | 2 |\n\nsome text | with a pipe\n'), []);
});

test('a line without a pipe ends the table; a later line is not compared with it', () => {
  assert.deepEqual(findBadRows('| a | b |\n|---|---|\n| 1 | 2 |\nplain line\n| 3 |\n'), []);
});

test('a line that is not a table has no header to compare with', () => {
  assert.deepEqual(findBadRows('a | b\nc | d | e\n'), []);
});

test('checkFiles names the file of each bad row', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'doctables-'));
  try {
    fs.writeFileSync(path.join(dir, 'ok.md'), '| a |\n|---|\n| 1 |\n');
    fs.writeFileSync(path.join(dir, 'bad.md'), '| a | b |\n|---|---|\n| 1 |\n');
    const r = checkFiles([path.join(dir, 'ok.md'), path.join(dir, 'bad.md')]);
    assert.equal(r.checked, 2);
    assert.deepEqual(r.problems.map((p) => [path.basename(p.file), p.line, p.cells, p.expected]), [['bad.md', 3, 1, 2]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
