'use strict';
// Every page under docs/ starts with one level-one heading on its first non-empty line and has no
// second level-one heading outside code fences. The checker is exercised on temporary pages first,
// then run over the real docs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');

const docsDir = path.resolve(__dirname, '..', '..', '..', 'docs');

function markdownFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...markdownFiles(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out.sort();
}

// Returns a list of problems for one page's text (empty when the page is fine).
function headingProblems(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const problems = [];
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first === -1) return ['page is empty'];
  if (!/^# \S/.test(lines[first])) problems.push('first non-empty line is not a level-one heading');
  let fence = null;
  let h1 = 0;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!fence) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1].trim()) fence = null;
      continue;
    }
    if (!fence && /^# \S/.test(line)) h1++;
  }
  if (h1 > 1) problems.push('more than one level-one heading outside code fences');
  return problems;
}

function check(t, text) {
  const dir = tempDir(t, 'zn-docs-heading-');
  const file = path.join(dir, 'page.md');
  fs.writeFileSync(file, text);
  return headingProblems(fs.readFileSync(file, 'utf8'));
}

test('a page with one leading heading passes', (t) => {
  assert.deepEqual(check(t, '\n\n# Title\n\nText\n\n## Part\n'), []);
});

test('a page whose first line is not a heading is rejected', (t) => {
  assert.equal(check(t, 'Intro text\n\n# Title\n').length, 1);
  assert.equal(check(t, '## Title\n').length, 1);
});

test('a second level-one heading is rejected', (t) => {
  assert.deepEqual(check(t, '# One\n\n# Two\n'), ['more than one level-one heading outside code fences']);
});

test('a hash line inside a code fence is not a heading', (t) => {
  assert.deepEqual(check(t, '# Title\n\n```sh\n# a comment\n```\n\n~~~\n# another\n~~~\n'), []);
  assert.deepEqual(check(t, '# Title\n\n````md\n```\n# still inside\n```\n````\n'), []);
});

test('a heading after a closed fence counts again', (t) => {
  assert.equal(check(t, '# Title\n\n```\ncode\n```\n\n# Again\n').length, 1);
});

test('an empty page is rejected', (t) => {
  assert.deepEqual(check(t, '\n  \n'), ['page is empty']);
});

test('every page under docs/ has exactly one leading level-one heading', { skip: !fs.existsSync(docsDir) }, () => {
  const files = markdownFiles(docsDir);
  assert.ok(files.length > 0);
  for (const f of files) {
    assert.deepEqual(headingProblems(fs.readFileSync(f, 'utf8')), [], path.relative(docsDir, f));
  }
});
