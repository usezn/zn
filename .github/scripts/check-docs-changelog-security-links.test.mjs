// Tests of check-docs-changelog-security-links.mjs. Run: node --test .github/scripts/check-docs-changelog-security-links.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { anchors, checkRepo, linkTargets, slug, splitTarget } from './check-docs-changelog-security-links.mjs';

test('headings are slugged like GitHub, repeats get -1, -2', () => {
  assert.equal(slug('Install Guide'), 'install-guide');
  assert.equal(slug("What's new (1.2)?"), 'whats-new-12');
  assert.equal(slug('`zn` & [docs](x.md)'), 'zn--docs');
  assert.equal(slug('Información'), 'información');
  assert.deepEqual([...anchors('## Notes\n## Notes\n## Notes\n')], ['notes', 'notes-1', 'notes-2']);
});

test('headings inside fenced code are not anchors', () => {
  assert.deepEqual([...anchors('```\n# Hidden\n```\n# Shown\n')], ['shown']);
});

test('inline and reference links are found, code spans and fences are not', () => {
  const text = 'see [a](../CHANGELOG.md#x) and `[b](../CHANGELOG.md)`\n```md\n[c](../CHANGELOG.md)\n```\n[d]: ../SECURITY.md\n';
  assert.deepEqual(linkTargets(text), [
    { n: 1, target: '../CHANGELOG.md#x' },
    { n: 5, target: '../SECURITY.md' },
  ]);
});

test('HTML anchors with an href are links too', () => {
  const text = '<a href="SECURITY.md">Security</a> and <a name="x">no</a>\n';
  assert.deepEqual(linkTargets(text), [{ n: 1, target: 'SECURITY.md' }]);
});

test('only relative file links are split into file and anchor', () => {
  assert.equal(splitTarget('https://example.com/CHANGELOG.md'), null);
  assert.equal(splitTarget('#top'), null);
  assert.equal(splitTarget('/CHANGELOG.md'), null);
  assert.deepEqual(splitTarget('../CHANGELOG.md#1-0-0'), { file: '../CHANGELOG.md', anchor: '1-0-0' });
});

function tree(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'doclinks-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const CHANGELOG = '# Changelog\n\n## 1.0.0\n\n## 1.0.0\n\n### `zn secret` fix\n';

test('valid file and anchor links pass, including repeated and code headings', () => {
  const root = tree({
    'CHANGELOG.md': CHANGELOG,
    'SECURITY.md': '# Security policy\n',
    'docs/guide.md':
      '[a](../CHANGELOG.md)\n[b](../CHANGELOG.md#100)\n[c](../CHANGELOG.md#100-1)\n' +
      '[d](../SECURITY.md#security-policy)\n[e](../CHANGELOG.md#zn-secret-fix)\n',
  });
  const r = checkRepo(root);
  assert.equal(r.links, 5);
  assert.deepEqual(r.problems, []);
});

test('a missing file or a missing anchor is reported with file and line', () => {
  const root = tree({
    'CHANGELOG.md': CHANGELOG,
    'docs/guide.md': 'intro\n[x](CHANGELOG.md)\n[y](./missing/SECURITY.md)\n[z](../CHANGELOG.md#nope)\n',
  });
  const r = checkRepo(root);
  assert.deepEqual(
    r.problems.map((p) => [p.file, p.line]),
    [['docs/guide.md', 2], ['docs/guide.md', 3], ['docs/guide.md', 4]],
  );
});

test('a link to a file that exists only as a directory is broken', () => {
  const root = tree({ 'CHANGELOG.md': CHANGELOG, 'docs/SECURITY.md/index.md': '# Hi\n', 'docs/a.md': '[x](SECURITY.md)\n' });
  assert.deepEqual(checkRepo(root).problems.map((p) => p.line), [1]);
});

test('links in fenced code and code spans are ignored', () => {
  const root = tree({
    'CHANGELOG.md': CHANGELOG,
    'docs/a.md': '```md\n[x](../CHANGELOG.md#nope)\n```\n`[y](nowhere/CHANGELOG.md)`\n',
  });
  assert.deepEqual(checkRepo(root).problems, []);
});

test('reference definitions are checked', () => {
  const root = tree({ 'CHANGELOG.md': CHANGELOG, 'docs/a.md': '[log]: ../CHANGELOG.md#missing\n' });
  assert.deepEqual(checkRepo(root).problems.map((p) => [p.file, p.line]), [['docs/a.md', 1]]);
});

test('other files, external URLs and other names are not checked', () => {
  const root = tree({
    'CHANGELOG.md': CHANGELOG,
    'docs/a.md': '[x](https://example.com/CHANGELOG.md)\n[y](other.md#changelog)\n[z](../NOTES.md)\n',
    'src/b.md': '[w](nowhere/SECURITY.md)\n',
  });
  const r = checkRepo(root);
  assert.equal(r.links, 0);
  assert.deepEqual(r.problems, []);
});

test('README files covered by the docs checks are checked, others are not', () => {
  const root = tree({
    'CHANGELOG.md': CHANGELOG,
    'README.md': '[x](CHANGELOG.md#gone)\n',
    'packages/zn-gate/README.md': '[x](../../CHANGELOG.md#gone)\n',
    'changelog.d/README.md': '[x](../CHANGELOG.md#gone)\n',
    'plugins/x/README.md': '[x](nowhere.md)\n[y](../../SECURITY.md)\n',
  });
  const r = checkRepo(root);
  assert.deepEqual(r.problems.map((p) => p.file), ['README.md', 'changelog.d/README.md', 'packages/zn-gate/README.md']);
});
