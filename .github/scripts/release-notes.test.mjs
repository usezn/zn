// Tests for release-notes.mjs: run with `node --test .github/scripts/release-notes.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cutAtBullet, GITHUB_LIMIT, releaseNotes, section, without } from './release-notes.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-notes.mjs');
const opts = { version: '2.0.0', tag: 'v2.0.0', repo: 'usezn/zn' };

function changelog(fixedBullets, { added = 3, changed = 0, security = 2, width = 200 } = {}) {
  const bullet = (s, i) => `- ${s} ${i}: ${'x'.repeat(width)}`;
  return [
    '# Changelog', '', '## [Unreleased]', '', '## [2.0.0] - 2026-11-03', '', 'Intro paragraph.', '',
    '### Added', ...Array.from({ length: added }, (_, i) => bullet('added', i)), '',
    ...(changed ? ['### Changed', ...Array.from({ length: changed }, (_, i) => bullet('changed', i)), ''] : []),
    '### Fixed', ...Array.from({ length: fixedBullets }, (_, i) => bullet('fixed', i) + '\n  continued line'), '',
    '### Security', ...Array.from({ length: security }, (_, i) => bullet('security', i)), '',
    '## [1.9.0] - 2026-10-20', '', '### Fixed', '- old fix', '',
  ].join('\n');
}

test('section takes the lines of one version only', () => {
  const s = section(changelog(1), '2.0.0');
  assert.match(s, /Intro paragraph/);
  assert.match(s, /### Security/);
  assert.doesNotMatch(s, /old fix/);
  assert.equal(section(changelog(1), '3.0.0'), null);
});

test('short notes are the section plus the verify footer, unchanged', () => {
  const { notes, shortened } = releaseNotes(changelog(2), opts);
  assert.equal(shortened, null);
  assert.match(notes, /fixed 1:/);
  assert.match(notes, /How to verify these files: \[docs\/verify-release\.md\]\(https:\/\/github\.com\/usezn\/zn\/blob\/v2\.0\.0\/docs\/verify-release\.md\)\n$/);
  assert.doesNotMatch(notes, /shortened/);
});

test('notes over the limit leave out the Fixed list and link the full CHANGELOG', () => {
  const big = changelog(700);
  assert.ok(section(big, '2.0.0').length > GITHUB_LIMIT);
  const { notes, shortened } = releaseNotes(big, opts);
  assert.equal(shortened, 'without the Fixed list');
  assert.ok(notes.length < GITHUB_LIMIT);
  assert.doesNotMatch(notes, /### Fixed|fixed 0:/);
  assert.match(notes, /### Added[\s\S]*added 2:[\s\S]*### Security[\s\S]*security 1:/);
  assert.match(notes, /the Fixed list is left out\. The full notes are in \[CHANGELOG\.md\]\(https:\/\/github\.com\/usezn\/zn\/blob\/v2\.0\.0\/CHANGELOG\.md\)/);
  assert.match(notes, /How to verify these files/);
});

test('notes still too long without Fixed are cut at a whole bullet', () => {
  const big = changelog(10, { added: 900 });
  const { notes, shortened } = releaseNotes(big, opts);
  assert.equal(shortened, 'without the Fixed list and cut at the last bullet that fits');
  assert.ok(notes.length < GITHUB_LIMIT);
  const body = notes.split('\n\nThese notes are shortened')[0];
  assert.match(body.split('\n').pop(), /^- added \d+: x{200}$/);
});

test('still too long without Fixed: Changed goes too, Security and Added stay', () => {
  const { notes, shortened } = releaseNotes(changelog(300, { changed: 600 }), opts);
  assert.equal(shortened, 'without the Fixed and Changed lists');
  assert.ok(notes.length < GITHUB_LIMIT);
  assert.doesNotMatch(notes, /### (Fixed|Changed)/);
  assert.match(notes, /### Added[\s\S]*### Security[\s\S]*security 1:/);
  assert.match(notes, /the Fixed and Changed lists are left out\./);
});

test('without keeps the other subsections; cutAtBullet never ends on a heading', () => {
  const s = section(changelog(3), '2.0.0');
  const w = without(s, 'Fixed');
  assert.doesNotMatch(w, /### Fixed/);
  assert.match(w, /### Added[\s\S]*### Security/);
  const cut = cutAtBullet('### A\n- one\n- two\n\n### B\n- three', 21);
  assert.equal(cut, '### A\n- one\n- two');
  assert.equal(cutAtBullet('short', 100), 'short');
});

test('CLI prints the notes, warns when shortened and fails without a section', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-notes-'));
  const file = path.join(dir, 'CHANGELOG.md');
  writeFileSync(file, changelog(700));
  const ok = spawnSync(process.execPath, [script, '--version', '2.0.0', '--tag', 'v2.0.0', '--repo', 'usezn/zn', '--changelog', file], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /::warning::.*without the Fixed list/);
  assert.ok(ok.stdout.length < GITHUB_LIMIT);
  const missing = spawnSync(process.execPath, [script, '--version', '9.9.9', '--tag', 'v9.9.9', '--repo', 'usezn/zn', '--changelog', file], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /::error::No section for 9\.9\.9/);
  const usage = spawnSync(process.execPath, [script, '--version', '2.0.0'], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
});
