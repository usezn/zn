'use strict';
// Every relative link in a Markdown page under docs/ and in the npm README must point to a file
// or folder that exists, so a moved or renamed page cannot leave a dead link behind.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..', '..');
const docsDir = path.join(repo, 'docs');
const readme = path.join(__dirname, '..', 'README.md');
const present = fs.existsSync(docsDir);

function markdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function relativeTargets(md) {
  // Drop fenced and inline code, then collect inline and reference-style link targets.
  const text = md.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, '').replace(/`[^`\n]*`/g, '');
  const raw = [];
  for (const m of text.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) raw.push(m[1]);
  for (const m of text.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/gm)) raw.push(m[1]);
  return raw.filter((t) => !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(t));
}

const pages = present ? [...markdownFiles(docsDir), readme] : [];

test('the docs folder and the npm README can be checked', { skip: present ? false : 'docs/ not in this checkout' }, () => {
  assert.ok(pages.length > 1);
});

for (const page of pages) {
  const label = path.relative(repo, page).split(path.sep).join('/');
  test(`relative links in ${label} resolve to existing files`, () => {
    const missing = [];
    for (const target of relativeTargets(fs.readFileSync(page, 'utf8'))) {
      const file = decodeURIComponent(target.split('#')[0].split('?')[0]);
      if (!file) continue;
      const resolved = file.startsWith('/') ? path.join(repo, file) : path.resolve(path.dirname(page), file);
      if (!fs.existsSync(resolved)) missing.push(target);
    }
    assert.deepStrictEqual(missing, []);
  });
}
