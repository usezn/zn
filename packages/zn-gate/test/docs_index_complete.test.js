'use strict';
// Every Markdown page under docs/ must be reachable from docs/README.md: linked from it directly, or
// linked from an index page (a README.md inside docs/, such as docs/editors/README.md and
// docs/examples/README.md) that docs/README.md links. Only index pages pass the walk on: a page
// that is linked only from a normal page is not counted, so a reader of the docs index can find
// every page in at most two clicks. Files outside the docs folder (such as the README.md of the
// repository root, which docs/README.md links) are never followed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..', '..');

// Pages that are fine without a link from the docs index. Paths are relative to docs/.
// Add a page here only with a reason, for example:
//   ['internal-notes.md', 'generated file, not meant for readers'],
// Today every page is linked, so the list is empty.
const ALLOW_UNLINKED = new Map([]);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function stripCode(md) {
  return md.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, '').replace(/`[^`\n]*`/g, '');
}

// Relative Markdown targets of a file (inline links and reference definitions), as absolute paths.
function linkedPages(file) {
  const text = stripCode(fs.readFileSync(file, 'utf8'));
  const targets = [];
  const inline = /\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  const refdef = /^\s{0,3}\[[^\]\n]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/gm;
  for (const re of [inline, refdef]) {
    let m;
    while ((m = re.exec(text))) {
      let target = m[1];
      if (target.startsWith('#') || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      target = target.split('#')[0].split('?')[0];
      if (!target.endsWith('.md')) continue;
      try { target = decodeURIComponent(target); } catch { /* keep as written */ }
      targets.push(path.resolve(path.dirname(file), target));
    }
  }
  return targets;
}

// Returns the pages of docsDir (relative, with / separators) that docs/README.md does not reach.
function unreachable(docsDir) {
  const root = path.resolve(docsDir);
  const insideDocs = (f) => {
    const rel = path.relative(root, f);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const start = path.join(root, 'README.md');
  const all = walk(root);
  const reached = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const file = queue.shift();
    // Only the docs index and index pages (README.md) pass the walk on.
    if (path.basename(file) !== 'README.md') continue;
    for (const t of linkedPages(file)) {
      if (!insideDocs(t)) continue;
      if (!reached.has(t) && fs.existsSync(t)) {
        reached.add(t);
        queue.push(t);
      }
    }
  }
  return all
    .filter((f) => !reached.has(f))
    .map((f) => path.relative(root, f).split(path.sep).join('/'));
}

test('every page under docs/ is linked from docs/README.md or from an index page it links', () => {
  const missing = unreachable(path.join(repo, 'docs')).filter((p) => !ALLOW_UNLINKED.has(p));
  assert.deepStrictEqual(missing, [], 'not linked from the docs index: ' + missing.join(', ')
    + '. Add a link in docs/README.md (or in the README.md of its folder), or list it in ALLOW_UNLINKED with a reason.');
});

test('every entry of the allow-list is a page that exists and is still unlinked', () => {
  const docs = path.join(repo, 'docs');
  const unlinked = new Set(unreachable(docs));
  for (const [p, reason] of ALLOW_UNLINKED) {
    assert.ok(reason && reason.length > 0, p + ' needs a reason');
    assert.ok(fs.existsSync(path.join(docs, p)), p + ' is in the allow-list but does not exist');
    assert.ok(unlinked.has(p), p + ' is linked from the docs index now: remove it from ALLOW_UNLINKED');
  }
});

test('the check finds a page that no index links, follows an index page, and ignores code samples', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-index-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'README.md'), '# Docs\n\n- [A](a.md)\n- [Sub](sub/README.md)\n\n```\n[B](b.md)\n```\n');
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\n[C](c.md)\n');
    fs.writeFileSync(path.join(dir, 'b.md'), '# B\n');
    fs.writeFileSync(path.join(dir, 'c.md'), '# C\n');
    fs.writeFileSync(path.join(dir, 'sub', 'README.md'), '# Sub\n\n[D](d.md)\n');
    fs.writeFileSync(path.join(dir, 'sub', 'd.md'), '# D\n');
    // b.md is only in a code sample; c.md is linked only from a normal page; d.md is linked from an index page.
    assert.deepStrictEqual(unreachable(dir).sort(), ['b.md', 'c.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('a README.md outside the docs folder does not count as an index page', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-index-'));
  try {
    const dir = path.join(base, 'docs');
    fs.mkdirSync(dir);
    // docs/README.md links the README.md of the folder above it, and that one links docs/e.md.
    fs.writeFileSync(path.join(dir, 'README.md'), '# Docs\n\n- [A](a.md)\n- [Repository](../README.md)\n');
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n');
    fs.writeFileSync(path.join(dir, 'e.md'), '# E\n');
    fs.writeFileSync(path.join(base, 'README.md'), '# Repository\n\n[E](docs/e.md)\n');
    assert.deepStrictEqual(unreachable(dir), ['e.md']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
