// Tests of check-docs-examples-sections.mjs. Run: node --test .github/scripts/check-docs-examples-sections.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCEPTED_HEADINGS, checkSections, examplePages, hasClosingSection, problemMessage,
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
