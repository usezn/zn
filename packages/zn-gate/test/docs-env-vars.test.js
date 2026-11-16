'use strict';
// Every ZN_ environment variable named in the CLI docs must be read somewhere in lib/ or bin/,
// unless it is on the short docs-only list below. Secret markers such as __ZN_API_KEY__ are not
// environment variables and are ignored.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pkg = path.resolve(__dirname, '..');
const repo = path.resolve(pkg, '..', '..');
const docs = ['cli.md', 'first-5-minutes.md'].map((f) => path.join(repo, 'docs', f));
const present = docs.every((f) => fs.existsSync(f));

// Names that may appear in the docs without being read by the code (none today).
const DOCS_ONLY = new Set([]);

function docNames() {
  const names = new Set();
  for (const f of docs) {
    const text = fs.readFileSync(f, 'utf8').replace(/__ZN_[A-Z0-9_]*?__/g, '');
    for (const m of text.matchAll(/\bZN_[A-Z][A-Z0-9_]*/g)) names.add(m[0]);
  }
  return [...names].sort();
}

function sourceText() {
  let out = '';
  for (const dir of ['lib', 'bin']) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) out += fs.readFileSync(p, 'utf8') + '\n';
      }
    };
    walk(path.join(pkg, dir));
  }
  return out;
}

test('docs name at least one ZN_ variable', { skip: !present }, () => {
  assert.ok(docNames().length > 0);
});

test('every ZN_ variable in the docs is read in lib/ or bin/', { skip: !present }, () => {
  const src = sourceText();
  const missing = docNames().filter(
    (n) => !DOCS_ONLY.has(n) && !new RegExp('\\b' + n + '\\b').test(src)
  );
  assert.deepStrictEqual(missing, [], 'documented but never read: ' + missing.join(', '));
});

test('the docs-only list holds no stale names', { skip: !present }, () => {
  const src = sourceText();
  const names = new Set(docNames());
  for (const n of DOCS_ONLY) {
    assert.ok(names.has(n), n + ' is not in the docs any more');
    assert.ok(!new RegExp('\\b' + n + '\\b').test(src), n + ' is read by the code now');
  }
});
