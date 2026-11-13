// Tests of check-docs-anchors.mjs. Run: node --test .github/scripts/check-docs-anchors.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkDir, headingsOf, repeatedAnchors, slugOf } from './check-docs-anchors.mjs';

test('slugs follow GitHub: lowercase, punctuation dropped, each space a hyphen', () => {
  assert.equal(slugOf('Install'), 'install');
  assert.equal(slugOf('Check that it works'), 'check-that-it-works');
  assert.equal(slugOf('`zn hooks install`'), 'zn-hooks-install');
  assert.equal(slugOf('Why? (A/B) testing'), 'why-ab-testing');
  assert.equal(slugOf('Set up_the [guide](x.md)'), 'set-up_the-guide');
  assert.equal(slugOf('Café'), 'café');
});

test('headings in fenced code blocks, and lines without a space after the hashes, are not headings', () => {
  const md = '```md\n# Not a heading\n```\n~~~\n# also not\n~~~\n# Real\n#nospace\n';
  assert.deepEqual(headingsOf(md).map((h) => h.text), ['Real']);
});

test('two identical headings on one page repeat the anchor, whatever their level', () => {
  const r = repeatedAnchors('# Options\n\ntext\n\n## Options\n');
  assert.equal(r.length, 1);
  assert.equal(r[0].anchor, 'options');
  assert.deepEqual(r[0].headings.map((h) => h.line), [1, 5]);
});

test('headings that differ only in case or punctuation still repeat', () => {
  const r = repeatedAnchors('## Run: now\n\n## run now\n');
  assert.equal(r.length, 1);
  assert.equal(r[0].anchor, 'run-now');
});

test('distinct headings, and a heading that only appears in a code block, do not repeat', () => {
  assert.deepEqual(repeatedAnchors('# A\n\n```\n# A\n```\n\n# B\n'), []);
});

function tree(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'docanchors-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('the same heading on two pages is not a repeat', () => {
  const dir = tree({ 'a.md': '# Install\n', 'sub/b.md': '# Install\n' });
  const r = checkDir(dir);
  assert.equal(r.checked, 2);
  assert.deepEqual(r.problems, []);
});

test('two identical headings in one file fail, and the problem names that file', () => {
  const dir = tree({ 'a.md': '# Install\n', 'sub/b.md': '## Usage\n\n### Usage\n' });
  const r = checkDir(dir);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].file, 'sub/b.md');
  assert.equal(r.problems[0].anchor, 'usage');
});
