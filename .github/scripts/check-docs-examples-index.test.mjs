// Tests of check-docs-examples-index.mjs. Run: node --test .github/scripts/check-docs-examples-index.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { duplicates, outOfOrder, sections } from './check-docs-examples-index.mjs';

const entry = (name) => `- [${name}](${name}): text.\n`;

test('a sorted list passes', () => {
  assert.deepEqual(outOfOrder('# Examples\n\n' + entry('a.md') + entry('b.md') + entry('c.md')), []);
});

test('two swapped entries are reported with their lines', () => {
  const r = outOfOrder('# Examples\n\n' + entry('a.md') + entry('c.md') + entry('b.md'));
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'b.md');
  assert.equal(r[0].line, 5);
  assert.equal(r[0].after, 'c.md');
  assert.equal(r[0].afterLine, 4);
});

test('each section is sorted on its own', () => {
  const text = '# Examples\n\n## First\n\n' + entry('m.md') + entry('n.md') + '\n## Second\n\n' + entry('a.md') + entry('b.md');
  assert.deepEqual(outOfOrder(text), []);
  assert.equal(sections(text).length, 4);
});

test('an out-of-order entry names its section', () => {
  const text = '## Setup\n\n' + entry('z.md') + entry('y.md');
  assert.equal(outOfOrder(text)[0].heading, 'Setup');
});

test('entries before the first heading belong to one list', () => {
  assert.equal(outOfOrder(entry('b.md') + entry('a.md')).length, 1);
});

test('names are compared in plain character order, so a hyphen sorts before a letter', () => {
  assert.deepEqual(outOfOrder(entry('zn-a.md') + entry('zn.md')), []);
  assert.equal(outOfOrder(entry('zn.md') + entry('zn-a.md')).length, 1);
});

test('entries inside a code fence and lines that are not entries are ignored', () => {
  const text = entry('b.md') + '```md\n' + entry('a.md') + '```\n' + 'Some text.\n' + entry('c.md');
  assert.deepEqual(outOfOrder(text), []);
});

test('CRLF line endings give the same result', () => {
  const text = ('# Examples\n\n' + entry('b.md') + entry('a.md')).replace(/\n/g, '\r\n');
  assert.equal(outOfOrder(text).length, 1);
});

test('a page listed once in each of two sections is reported as listed twice', () => {
  const text = '## First\n\n' + entry('a.md') + entry('b.md') + '\n## Second\n\n' + entry('a.md');
  assert.deepEqual(duplicates(text), [{ name: 'a.md', lines: [3, 8] }]);
});

test('two lines of one page next to each other, as a union merge leaves them, are reported', () => {
  const text = entry('a.md') + '- [b.md](b.md): old text.\n' + '- [b.md](b.md): new text.\n';
  assert.deepEqual(outOfOrder(text), []);
  assert.deepEqual(duplicates(text), [{ name: 'b.md', lines: [2, 3] }]);
});

test('an index that lists each page once has no duplicates', () => {
  assert.deepEqual(duplicates(entry('a.md') + entry('b.md') + '```md\n' + entry('a.md') + '```\n'), []);
});
