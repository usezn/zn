'use strict';
// Every editor page under docs/editors/ that has an "Install (no coding needed)" section lays out its
// level-two sections in the same order: Install, what zn-gate protects, Technical reference, Verify,
// Uninstall, Troubleshooting, then the editor's own documentation. Other sections may sit in between.
// The page ends with the vendor documentation links: no external link comes after that section (a
// closing list of links to other zn-gate pages is fine). The checker is exercised on temporary pages
// first, then run over the real docs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');

const editorsDir = path.resolve(__dirname, '..', '..', '..', 'docs', 'editors');

const INSTALL = /^Install \(no coding needed\)$/;

const ORDER = [
  ['Install', INSTALL],
  ['What zn-gate protects', /^What zn-gate protects in .+, and what it does not$/],
  ['Technical reference', /^Technical reference$/],
  ['Verify', /^Verify$/],
  ['Uninstall', /^Uninstall$/],
  ['Troubleshooting', /^Troubleshooting$/],
  ['vendor documentation', /^(?!zn-gate\b).+ documentation$/],
];

const EXTERNAL_LINK = /<https?:\/\/[^>\s]+>|\]\(https?:\/\/[^)\s]+\)/;

// Splits a page into level-two sections ({ title, lines }), skipping code fences.
function sections(text) {
  const out = [];
  let current = null;
  let fence = null;
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      if (current) current.lines.push(line);
      continue;
    }
    if (f) {
      fence = f[1];
      if (current) current.lines.push(line);
      continue;
    }
    const h = /^## (.+?)\s*#*\s*$/.exec(line);
    if (h) {
      current = { title: h[1].trim(), lines: [] };
      out.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return out;
}

function hasInstallSection(text) {
  return sections(text).some((s) => INSTALL.test(s.title));
}

// Returns a list of problems for one page's text (empty when the page is fine).
function orderProblems(text) {
  const secs = sections(text);
  const problems = [];
  let last = -1;
  let lastName = null;
  for (const [name, re] of ORDER) {
    const at = secs.findIndex((s) => re.test(s.title));
    if (at === -1) {
      problems.push('missing section: ' + name);
      continue;
    }
    if (at <= last) problems.push(name + ' comes before ' + lastName);
    last = Math.max(last, at);
    lastName = name;
  }
  const vendor = secs.findIndex((s) => ORDER[ORDER.length - 1][1].test(s.title));
  if (vendor !== -1) {
    if (!secs[vendor].lines.some((l) => EXTERNAL_LINK.test(l))) {
      problems.push('vendor documentation section has no external link');
    }
    for (const s of secs.slice(vendor + 1)) {
      if (s.lines.some((l) => EXTERNAL_LINK.test(l))) {
        problems.push('external link after the vendor documentation section, in: ' + s.title);
      }
    }
  }
  return problems;
}

function check(t, text) {
  const dir = tempDir(t, 'zn-docs-editor-order-');
  const file = path.join(dir, 'editor.md');
  fs.writeFileSync(file, text);
  return orderProblems(fs.readFileSync(file, 'utf8'));
}

const GOOD = [
  '# Example Editor',
  '',
  '## Install (no coding needed)',
  '',
  '## What zn-gate protects in Example Editor, and what it does not',
  '',
  '## Technical reference',
  '',
  '### Where the configuration lives',
  '',
  '## Verify',
  '',
  '## Uninstall',
  '',
  '## Troubleshooting',
  '',
  '## Example Editor documentation',
  '',
  '- MCP: <https://docs.example.com/mcp>',
  '',
];

function page(lines) {
  return lines.join('\n');
}

test('a page in the expected order passes', (t) => {
  assert.deepEqual(check(t, page(GOOD)), []);
});

test('extra sections between the expected ones are allowed', (t) => {
  const lines = [...GOOD];
  lines.splice(lines.indexOf('## Technical reference'), 0, '## Known limits', '');
  lines.splice(lines.indexOf('## Troubleshooting'), 0, '## Questions people ask', '');
  assert.deepEqual(check(t, page(lines)), []);
});

test('a closing section with only links to other zn-gate pages is allowed', (t) => {
  assert.deepEqual(check(t, page([...GOOD, '## See also', '', '- [Glossary](../glossary.md)', ''])), []);
});

test('an external link after the vendor documentation section is rejected', (t) => {
  const text = page([...GOOD, '## Related pages', '', '- Other: <https://other.example.com/>', '']);
  assert.deepEqual(check(t, text), ['external link after the vendor documentation section, in: Related pages']);
});

test('a vendor documentation section without an external link is rejected', (t) => {
  const lines = GOOD.filter((l) => !l.startsWith('- MCP'));
  assert.deepEqual(check(t, page(lines)), ['vendor documentation section has no external link']);
});

test('Verify after Uninstall is rejected', (t) => {
  const lines = GOOD.map((l) => (l === '## Verify' ? '## Uninstall' : l === '## Uninstall' ? '## Verify' : l));
  assert.deepEqual(check(t, page(lines)), ['Uninstall comes before Verify']);
});

test('a missing Troubleshooting section is rejected', (t) => {
  assert.deepEqual(check(t, page(GOOD.filter((l) => l !== '## Troubleshooting'))), ['missing section: Troubleshooting']);
});

test('a heading inside a code fence does not count', (t) => {
  const lines = [...GOOD];
  lines.splice(lines.indexOf('## Install (no coding needed)') + 1, 0, '```md', '## Uninstall', '```');
  assert.deepEqual(check(t, page(lines)), []);
});

test('a page without the Install section is out of scope', () => {
  assert.equal(hasInstallSection('# Notes\n\n## Install the hooks\n\n## Verify\n'), false);
  assert.equal(hasInstallSection(page(GOOD)), true);
});

test('every editor page with an Install section follows the shared section order', { skip: !fs.existsSync(editorsDir) }, () => {
  const files = fs.readdirSync(editorsDir).filter((f) => f.endsWith('.md')).sort();
  const inScope = files.filter((f) => hasInstallSection(fs.readFileSync(path.join(editorsDir, f), 'utf8')));
  assert.ok(inScope.length >= 5, 'expected several editor pages with an Install section, found ' + inScope.length);
  for (const f of inScope) {
    assert.deepEqual(orderProblems(fs.readFileSync(path.join(editorsDir, f), 'utf8')), [], f);
  }
});
