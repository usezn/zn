'use strict';
// Every relative Markdown link in docs/*.md and docs/editors/*.md that stays inside docs/ must
// point to a file that exists. Anchors and links that leave docs/ are not checked.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..', '..');

function mdFiles(docsDir) {
  const out = [];
  for (const dir of [docsDir, path.join(docsDir, 'editors')]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.md')) out.push(path.join(dir, name));
    }
  }
  return out;
}

function stripCode(md) {
  return md.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, '').replace(/`[^`\n]*`/g, '');
}

// Returns the targets of relative links that stay inside docsDir and do not exist.
function brokenLinks(docsDir) {
  const root = path.resolve(docsDir);
  const broken = [];
  for (const file of mdFiles(root)) {
    const text = stripCode(fs.readFileSync(file, 'utf8'));
    const re = /\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
    let m;
    while ((m = re.exec(text))) {
      let target = m[1];
      if (target.startsWith('#') || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      target = target.split('#')[0].split('?')[0];
      if (!target) continue;
      let decoded = target;
      try { decoded = decodeURIComponent(target); } catch { /* keep as written */ }
      const abs = path.resolve(path.dirname(file), decoded);
      const rel = path.relative(root, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (!fs.existsSync(abs)) broken.push(path.relative(root, file).split(path.sep).join('/') + ' -> ' + target);
    }
  }
  return broken;
}

function tmpDocs(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-links-'));
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

test('the real docs have no broken relative links inside docs/', () => {
  const docs = path.join(repo, 'docs');
  if (!fs.existsSync(docs)) return;
  assert.deepStrictEqual(brokenLinks(docs), []);
});

test('a link to an existing file passes, including from docs/editors', () => {
  const d = tmpDocs({
    'a.md': '[b](b.md) [e](editors/e.md)',
    'b.md': '',
    'editors/e.md': '[up](../a.md) [sib](f.md)',
    'editors/f.md': '',
  });
  assert.deepStrictEqual(brokenLinks(d), []);
});

test('a link to a missing file is reported', () => {
  const d = tmpDocs({ 'a.md': '[x](missing.md)', 'editors/e.md': '[x](../gone.md)' });
  assert.deepStrictEqual(brokenLinks(d).sort(), ['a.md -> missing.md', 'editors/e.md -> ../gone.md']);
});

test('a missing file is reported even when the link has an anchor', () => {
  const d = tmpDocs({ 'a.md': '[x](missing.md#part) [y](b.md#part)', 'b.md': '' });
  assert.deepStrictEqual(brokenLinks(d), ['a.md -> missing.md']);
});

test('anchors, external links and links that leave docs/ are ignored', () => {
  const d = tmpDocs({
    'a.md': [
      '[a](#top)',
      '[b](https://example.com/nope.md)',
      '[c](mailto:user@example.com)',
      '[d](../README.md)',
      '[e](../src/none.rs)',
      '[f](editors/../../outside.md)',
    ].join('\n'),
  });
  assert.deepStrictEqual(brokenLinks(d), []);
});

test('links inside code are ignored', () => {
  const d = tmpDocs({ 'a.md': '`[x](nope.md)`\n\n```\n[y](nope2.md)\n```\n' });
  assert.deepStrictEqual(brokenLinks(d), []);
});

test('only docs/*.md and docs/editors/*.md are checked', () => {
  const d = tmpDocs({ 'deeper/x.md': '[x](missing.md)', 'notes.txt': '[x](missing.md)' });
  assert.deepStrictEqual(brokenLinks(d), []);
});
