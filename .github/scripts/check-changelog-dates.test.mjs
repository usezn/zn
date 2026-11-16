// Tests of check-changelog-dates.mjs. Run: node --test .github/scripts/check-changelog-dates.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkChangelog, isCalendarDate } from './check-changelog-dates.mjs';

test('ISO release dates pass and Unreleased needs no date', () => {
  const r = checkChangelog('# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-01-31\n\n### Fixed\n\n## [1.2.2] - 2025-12-01\n');
  assert.equal(r.checked, 2);
  assert.deepEqual(r.problems, []);
});

test('a date written with slashes fails and gives its line', () => {
  const r = checkChangelog('# Changelog\n## [1.0.0] - 5/11/2026\n');
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].line, 2);
});

test('a release heading without a date fails', () => {
  assert.equal(checkChangelog('## [1.0.0]\n').problems.length, 1);
});

test('a date that is not a calendar day fails', () => {
  assert.equal(checkChangelog('## [1.0.0] - 2026-02-30\n').problems.length, 1);
  assert.equal(checkChangelog('## [1.0.0] - 2026-13-01\n').problems.length, 1);
  assert.equal(checkChangelog('## [1.0.0] - 2026-00-10\n').problems.length, 1);
});

test('leap days are checked against the year', () => {
  assert.equal(checkChangelog('## [1.0.0] - 2028-02-29\n').problems.length, 0);
  assert.equal(checkChangelog('## [1.0.0] - 2027-02-29\n').problems.length, 1);
  assert.equal(isCalendarDate(2024, 2, 29), true);
  assert.equal(isCalendarDate(2026, 4, 31), false);
});

test('headings inside fenced code blocks are ignored', () => {
  const r = checkChangelog('```md\n## [1.0.0] - 5/11/2026\n```\n## [1.0.1] - 2026-01-02\n');
  assert.equal(r.checked, 1);
  assert.deepEqual(r.problems, []);
});
