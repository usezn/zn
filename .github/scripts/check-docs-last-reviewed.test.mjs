// Tests of check-docs-last-reviewed.mjs. Run: node --test .github/scripts/check-docs-last-reviewed.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkText, isCalendarDate, lastReviewedLines } from './check-docs-last-reviewed.mjs';

const LINE = 'Last reviewed: 2026-11-11';
const page = (line) => `# Title\n\n${line}\n\n## Body\n`;

test('a page with one valid line passes', () => {
  assert.deepEqual(checkText(page(LINE)), []);
});

test('a page without the line fails, and so does a good page after the line is removed', () => {
  assert.equal(checkText('# Title\n\n## Body\n').length, 1);
  assert.equal(checkText(page(LINE).replace(LINE + '\n', '')).length, 1);
});

test('two lines fail', () => {
  const problems = checkText(page(LINE) + '\n' + LINE + '\n');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /2 "Last reviewed:" lines/);
});

test('a value that is not a real calendar date fails', () => {
  for (const value of ['2026-02-30', '2026-13-01', '2026-11-1', '11-11-2026', '2026/11/11', 'yesterday', '']) {
    assert.equal(checkText(page('Last reviewed: ' + value)).length, 1, value);
  }
});

test('leap days are checked against the year', () => {
  assert.deepEqual(checkText(page('Last reviewed: 2028-02-29')), []);
  assert.equal(checkText(page('Last reviewed: 2026-02-29')).length, 1);
});

test('a line inside a fenced code block does not count', () => {
  assert.equal(checkText('# Title\n\n```md\n' + LINE + '\n```\n').length, 1);
});

test('the line number and the value are read, with surrounding spaces trimmed', () => {
  assert.deepEqual(lastReviewedLines('# T\n\nLast reviewed:  2026-11-11  \n'), [{ n: 3, value: '2026-11-11' }]);
});

test('isCalendarDate accepts only YYYY-MM-DD real days', () => {
  assert.equal(isCalendarDate('2026-11-11'), true);
  assert.equal(isCalendarDate('2026-04-31'), false);
  assert.equal(isCalendarDate('2026-11-11T00:00'), false);
});
