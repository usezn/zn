'use strict';
// Checks the anchor links in docs/: every link to a #section, in the same page or in another
// Markdown page, must name a heading that exists there. Headings become anchors the way GitHub
// does it. The slug helper is also tested on its own with temporary directories.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..', '..');
const docsDir = path.join(repo, 'docs');

function stripFences(md) {
  const out = [];
  let fence = null;
  for (const line of md.split('\n')) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      out.push('');
      continue;
    }
    out.push(fence ? '' : line);
  }
  return out.join('\n');
}

function slugify(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
    .replace(/ /g, '-');
}

function anchorsOf(md) {
  const seen = new Map();
  const anchors = new Set();
  for (const line of stripFences(md).split('\n')) {
    const m = line.match(/^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/);
    if (!m) continue;
    const base = slugify(m[1]);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

function linksOf(md) {
  const out = [];
  for (const m of stripFences(md).replace(/`[^`\n]*`/g, '').matchAll(/\]\(([^)\s]*)#([^)\s]*)\)/g)) {
    out.push({ target: m[1], anchor: m[2] });
  }
  return out;
}

function listMarkdown(dir) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...listMarkdown(p));
    else if (e.name.endsWith('.md')) files.push(p);
  }
  return files;
}

function problems(files) {
  const cache = new Map();
  const anchorsFor = (file) => {
    if (!cache.has(file)) cache.set(file, anchorsOf(fs.readFileSync(file, 'utf8')));
    return cache.get(file);
  };
  const bad = [];
  for (const file of files) {
    for (const { target, anchor } of linksOf(fs.readFileSync(file, 'utf8'))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // external link
      const dest = target ? path.resolve(path.dirname(file), target) : file;
      if (!dest.endsWith('.md') || !fs.existsSync(dest)) {
        bad.push(`${file}: ${target}#${anchor} points to a missing page`);
        continue;
      }
      let a = anchor;
      try { a = decodeURIComponent(anchor).toLowerCase(); } catch { /* keep raw */ }
      if (!anchorsFor(dest).has(a)) bad.push(`${file}: #${anchor} not found in ${dest}`);
    }
  }
  return bad;
}

test('heading slugs follow the GitHub rules', () => {
  const md = [
    '# Title: `code` and *emphasis*',
    '## What\'s new? (v1.2)',
    '## Repeat',
    '## Repeat',
    '## Repeat',
    '### 6. Numbered_item - dash',
    '```',
    '# not a heading',
    '```',
    '## Closed ##',
    '## Run `cmd <agent>` again',
  ].join('\n');
  const a = anchorsOf(md);
  for (const s of ['title-code-and-emphasis', 'whats-new-v12', 'repeat', 'repeat-1', 'repeat-2',
    '6-numbered_item---dash', 'closed', 'run-cmd-agent-again']) {
    assert.ok(a.has(s), `missing ${s}`);
  }
  assert.ok(!a.has('not-a-heading'));
});

test('the checker accepts good links and reports broken ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-anchors-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    const a = path.join(dir, 'a.md');
    const b = path.join(dir, 'sub', 'b.md');
    fs.writeFileSync(a, '# Alpha\n\n## Same page\n\n[ok](#same-page) [ok2](sub/b.md#beta-part) [ext](https://example.com/#nope)\n');
    fs.writeFileSync(b, '# Beta part\n\n[up](../a.md#alpha)\n');
    assert.deepStrictEqual(problems([a, b]), []);

    fs.writeFileSync(a, '# Alpha\n\n[bad](#missing) [bad2](sub/b.md#nothing) [bad3](gone.md#alpha)\n');
    assert.strictEqual(problems([a, b]).length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every anchor link in docs/ names an existing heading', { skip: !fs.existsSync(docsDir) }, () => {
  const files = listMarkdown(docsDir);
  assert.ok(files.length > 0);
  assert.deepStrictEqual(problems(files), []);
});
