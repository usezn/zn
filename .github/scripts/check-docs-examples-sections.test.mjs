// Tests of check-docs-examples-sections.mjs. Run: node --test .github/scripts/check-docs-examples-sections.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ACCEPTED_HEADINGS, checkSections, examplePages, hasClosingSection, problemMessage, usableBase,
} from './check-docs-examples-sections.mjs';

test('a page with each accepted closing heading passes', () => {
  for (const h of ACCEPTED_HEADINGS) {
    assert.equal(hasClosingSection(`# Example\n\nBody.\n\n## ${h}\n\n- [Link](x.md)\n`), true, h);
  }
});

test('the heading match ignores case, trailing spaces and closing hashes', () => {
  assert.equal(hasClosingSection('# Example\n\n## next STEPS  \n'), true);
  assert.equal(hasClosingSection('# Example\n\n## See also ##\n'), true);
});

test('a page without an accepted closing heading fails', () => {
  assert.equal(hasClosingSection('# Example\n\n## Setup\n\n## Usage\n'), false);
  assert.equal(hasClosingSection('# Example\n\nNo sections at all.\n'), false);
});

test('the heading must be level 2, outside code, and match the whole text', () => {
  assert.equal(hasClosingSection('# Example\n\n### Done\n'), false);
  assert.equal(hasClosingSection('# Example\n\n# Done\n'), false);
  assert.equal(hasClosingSection('# Example\n\n```md\n## Done\n```\n'), false);
  assert.equal(hasClosingSection('# Example\n\n## Done for now\n'), false);
});

test('examplePages keeps only direct docs/examples pages and exempts README.md', () => {
  assert.deepEqual(
    examplePages([
      'docs/examples/b.md',
      'docs/examples/README.md',
      'docs/examples/a.md',
      'docs/cli.md',
      'docs/examples/sub/c.md',
      'README.md',
      'docs/examples/d.txt',
    ]),
    ['docs/examples/a.md', 'docs/examples/b.md'],
  );
});

test('only the pages in the change list are checked; no change means nothing to check', () => {
  assert.deepEqual(examplePages([]), []);
  assert.deepEqual(checkSections([]), { checked: 0, problems: [] });
});

test('a changed page without a closing section is reported by name', () => {
  const r = checkSections([
    { name: 'docs/examples/a.md', text: '# A\n\n## Setup\n' },
    { name: 'docs/examples/b.md', text: '# B\n\n## Done\n' },
  ]);
  assert.equal(r.checked, 2);
  assert.deepEqual(r.problems, [{ file: 'docs/examples/a.md' }]);
});

test('the failure message names the file and every accepted heading', () => {
  const msg = problemMessage('docs/examples/a.md');
  assert.match(msg, /^docs\/examples\/a\.md: /);
  for (const h of ACCEPTED_HEADINGS) assert.ok(msg.includes(h), h);
});

test('usableBase rejects empty, missing and all-zero bases', () => {
  assert.equal(usableBase(''), false);
  assert.equal(usableBase(undefined), false);
  assert.equal(usableBase('0000000000000000000000000000000000000000'), false);
  assert.equal(usableBase('HEAD^1'), true);
  assert.equal(usableBase('ec7be395bb86845f5ad6f403abf7d16df9d69433'), true);
});

test('an empty or all-zero base skips with exit 0; a missing --base is a usage error', () => {
  const script = fileURLToPath(new URL('./check-docs-examples-sections.mjs', import.meta.url));
  for (const base of ['', '0000000000000000000000000000000000000000']) {
    const r = spawnSync(process.execPath, [script, '--base', base], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no usable base/);
  }
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage/);
});
