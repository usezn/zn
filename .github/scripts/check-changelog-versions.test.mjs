// Tests of check-changelog-versions.mjs. Run: node --test .github/scripts/check-changelog-versions.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { duplicateVersions, versionHeadings } from './check-changelog-versions.mjs';

test('distinct versions and Unreleased are not duplicates', () => {
  const text = '# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-01-02\n\n## [1.1.0] - 2025-12-01\n';
  assert.deepEqual(duplicateVersions(text), []);
  assert.deepEqual(versionHeadings(text).map((h) => h.version), ['Unreleased', '1.2.0', '1.1.0']);
});

test('a repeated version is reported with every line it appears on', () => {
  const text = '## [1.2.0] - 2026-01-02\n\n- a\n\n## [1.1.0] - 2025-12-01\n\n## [1.2.0] - 2026-01-02\n';
  assert.deepEqual(duplicateVersions(text), [{ version: '1.2.0', lines: [1, 7] }]);
});

test('headings inside a fenced code block do not count', () => {
  const text = '## [1.2.0] - 2026-01-02\n\n```md\n## [1.2.0] - 2026-01-02\n```\n';
  assert.deepEqual(duplicateVersions(text), []);
});

test('the comparison is case-sensitive on the text in the brackets', () => {
  assert.deepEqual(duplicateVersions('## [Unreleased]\n## [unreleased]\n'), []);
});

test('the script passes on a changelog without repeated versions', () => {
  const script = fileURLToPath(new URL('./check-changelog-versions.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [script, fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url))], { encoding: 'utf8' });
  assert.match(out, /changelog versions OK: \d+ heading/);
});
