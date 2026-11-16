// Tests of check-docs-tables.mjs. Run: node --test .github/scripts/check-docs-tables.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkFiles, findBadRows, findMissingSeparators, splitCells } from './check-docs-tables.mjs';

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

test('a table with no delimiter row under its first row is named with its line', () => {
  assert.deepEqual(findMissingSeparators('# T\n\n| a | b |\n| 1 | 2 |\n'), [{ line: 3 }]);
});

test('a table with its delimiter row is not reported as missing one', () => {
  assert.deepEqual(findMissingSeparators('| a | b |\n|---|---|\n| 1 | 2 |\n'), []);
});

test('a single line with a leading pipe is not a table', () => {
  assert.deepEqual(findMissingSeparators('| a | b |\n\ntext\n'), []);
});

test('rows inside a fenced code block are not checked for a delimiter row', () => {
  assert.deepEqual(findMissingSeparators('```md\n| a | b |\n| 1 | 2 |\n```\n'), []);
});

test('prose lines with a pipe but no leading pipe are not checked', () => {
  assert.deepEqual(findMissingSeparators('a | b\nc | d\n'), []);
});

test('a second table with no delimiter row is named at its own first row', () => {
  assert.deepEqual(findMissingSeparators('| a |\n|---|\n| 1 |\n\n| b | c |\n| 2 | 3 |\n'), [{ line: 5 }]);
});

test('checkFiles names the file of a table with no delimiter row', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'doctables-sep-'));
  try {
    fs.writeFileSync(path.join(dir, 'bad.md'), '| a | b |\n| 1 | 2 |\n');
    const r = checkFiles([path.join(dir, 'bad.md')]);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.missing.map((m) => [path.basename(m.file), m.line]), [['bad.md', 1]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
