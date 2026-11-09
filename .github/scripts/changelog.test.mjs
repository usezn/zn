import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseFragment, buildSection, assemble, checkPullRequest, needsFragment, fragmentHint } from './changelog.mjs';

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed
- An old fix still under Unreleased.

## [1.0.0] - 2026-01-01

### Added
- First release.
`;

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-changelog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'next'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), CHANGELOG);
  fs.mkdirSync(path.join(dir, 'packages', 'zn-gate', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'packages', 'zn-gate', 'lib', 'a.js'), '1\n');
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'feature');
  return { dir, g };
}

test('a fragment holds only section headings and bullets', () => {
  const ok = parseFragment('### Fixed\n- One.\n  continued.\n\n### Added\n- Two.\n');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.sections.Fixed, ['- One.\n  continued.']);
  assert.match(parseFragment('### Fixes\n- x\n').errors[0], /unknown section "Fixes"/);
  assert.match(parseFragment('- x\n').errors[0], /before any/);
  assert.match(parseFragment('### Added\nplain text\n').errors[0], /only/);
  assert.match(parseFragment('### Added\n').errors[0], /no bullets/);
});

test('an empty or whitespace-only fragment fails with a message that says it is empty', () => {
  for (const body of ['', '\n', '  \n\t\n', '﻿\n']) {
    const errors = parseFragment(body, 'changelog.d/x.md').errors;
    assert.equal(errors.length, 1, JSON.stringify(body));
    assert.match(errors[0], /^changelog\.d\/x\.md: the fragment is empty; add a "### <Section>" heading and at least one "- " bullet/);
  }
});

test('a pull request that adds an empty fragment fails the check', (t) => {
  const { dir, g } = repo(t);
  fs.mkdirSync(path.join(dir, 'changelog.d'));
  fs.writeFileSync(path.join(dir, 'changelog.d', 'empty.md'), '  \n\n');
  g('add', '-A'); g('commit', '-qm', 'empty fragment');
  assert.match(checkPullRequest(dir, 'next').errors.join(), /changelog\.d\/empty\.md: the fragment is empty/);
});

test('the release section merges [Unreleased] and the fragments in a fixed section order', () => {
  const s = buildSection('### Fixed\n- Old fix.', [parseFragment('### Fixed\n- New fix.\n### Added\n- New thing.\n')]);
  assert.equal(s, '### Added\n- New thing.\n\n### Fixed\n- Old fix.\n- New fix.\n');
});

test('assemble writes the version, empties [Unreleased] and deletes the fragments', (t) => {
  const { dir } = repo(t);
  fs.mkdirSync(path.join(dir, 'changelog.d'));
  fs.writeFileSync(path.join(dir, 'changelog.d', 'README.md'), 'how to\n');
  fs.writeFileSync(path.join(dir, 'changelog.d', 'feat-x.md'), '### Added\n- Feature X.\n');
  assemble(dir, '1.1.0', '2026-02-01');
  const out = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(out, /## \[Unreleased\]\n\n## \[1\.1\.0\] - 2026-02-01\n\n### Added\n- Feature X\.\n\n### Fixed\n- An old fix still under Unreleased\.\n\n## \[1\.0\.0\]/);
  assert.equal(fs.existsSync(path.join(dir, 'changelog.d', 'feat-x.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'changelog.d', 'README.md')), true);
  assert.throws(() => assemble(dir, '1.1.0', '2026-02-01'), /already has a section/);
});

test('a pull request that changes shipped code needs a fragment; docs and tests do not', (t) => {
  const { dir, g } = repo(t);
  fs.writeFileSync(path.join(dir, 'packages', 'zn-gate', 'lib', 'a.js'), '2\n');
  g('commit', '-qam', 'code');
  assert.match(checkPullRequest(dir, 'next').errors.join(), /adds no changelog\.d\/ fragment/);
  assert.deepEqual(checkPullRequest(dir, 'next', { skip: true }).errors, []);
  fs.mkdirSync(path.join(dir, 'changelog.d'));
  fs.writeFileSync(path.join(dir, 'changelog.d', 'feature.md'), '### Fixed\n- A fix.\n');
  g('add', '-A'); g('commit', '-qm', 'fragment');
  assert.deepEqual(checkPullRequest(dir, 'next').errors, []);
  assert.equal(needsFragment('docs/check.md'), false);
  assert.equal(needsFragment('packages/zn-gate/test/a.test.js'), false);
  assert.equal(needsFragment('packages/zn-gate/README.md'), false);
  assert.equal(needsFragment('packages/zn-gate-py/src/zn_gate/cli.py'), true);
});

test('editing [Unreleased] directly is refused, except on a release branch; a bad fragment fails', (t) => {
  const { dir, g } = repo(t);
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), CHANGELOG.replace('- An old fix still under Unreleased.', '- An old fix still under Unreleased.\n- Added by hand.'));
  g('commit', '-qam', 'edit');
  assert.match(checkPullRequest(dir, 'next').errors.join(), /\[Unreleased\] was edited/);
  assert.deepEqual(checkPullRequest(dir, 'next', { release: true }).errors, []);
  g('checkout', '-q', 'next'); g('checkout', '-q', '-b', 'bad');
  fs.mkdirSync(path.join(dir, 'changelog.d'));
  fs.writeFileSync(path.join(dir, 'changelog.d', 'bad.md'), 'just text\n');
  g('add', '-A'); g('commit', '-qm', 'bad');
  assert.match(checkPullRequest(dir, 'next').errors.join(), /only "### <Section>" headings/);
});

test('assemble moves the compare links to the new version', (t) => {
  const { dir } = repo(t);
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), CHANGELOG + '\n[Unreleased]: https://github.com/example/repo/compare/v1.0.0...next\n[1.0.0]: https://github.com/example/repo/releases/tag/v1.0.0\n');
  assemble(dir, '1.1.0', '2026-02-01');
  const out = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(out, /\[Unreleased\]: https:\/\/github\.com\/example\/repo\/compare\/v1\.1\.0\.\.\.next\n\[1\.1\.0\]: https:\/\/github\.com\/example\/repo\/compare\/v1\.0\.0\.\.\.v1\.1\.0\n\[1\.0\.0\]/);
});

test('shipped files: plugin skills and manifests count; repo tools, tests and fixtures do not', () => {
  for (const f of ['plugins/zn-gate/skills/zn-secrets/SKILL.md', '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json',
    'packages/zn-gate/server.json', 'skill/SKILL.md', 'Cargo.lock']) assert.equal(needsFragment(f), true, f);
  for (const f of ['plugins/tools/check-plugins.js', 'plugins/zn-gate/README.md', 'packages/zn-gate/lib/x.test.js',
    'packages/zn-gate/test/fixtures/a.json', 'plugins/zn-gate/tests/a.js']) assert.equal(needsFragment(f), false, f);
});

test('a fragment with a byte order mark, a non-ASCII name, or in a subfolder', (t) => {
  assert.deepEqual(parseFragment('﻿### Fixed\n- x\n').errors, []);
  const { dir, g } = repo(t);
  fs.writeFileSync(path.join(dir, 'packages', 'zn-gate', 'lib', 'a.js'), '2\n');
  fs.mkdirSync(path.join(dir, 'changelog.d', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'changelog.d', 'café fix.md'), '### Fixed\n- A fix.\n');
  g('add', '-A'); g('commit', '-qm', 'accent');
  assert.deepEqual(checkPullRequest(dir, 'next').errors, []);
  fs.writeFileSync(path.join(dir, 'changelog.d', 'sub', 'x.md'), '### Fixed\n- Lost.\n');
  g('add', '-A'); g('commit', '-qm', 'sub');
  assert.match(checkPullRequest(dir, 'next').errors.join(), /directly in changelog\.d/);
});

test('the failure hint shows a template that parses as a valid fragment', () => {
  const text = fragmentHint();
  const block = text.split('```markdown\n')[1].split('```')[0];
  assert.deepEqual(parseFragment(block, 'hint').errors, []);
  assert.match(text, /changelog\.d\/fix-init-guard\.md/);
  assert.match(text, /no-changelog/);
});
