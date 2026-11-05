'use strict';
// No docs page may have two headings with the same text at the same level (outside code blocks):
// the second one would get a numbered anchor (for example "#setup-1") that links no longer find.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..', '..');
const docsDir = path.join(repo, 'docs');

function markdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

// Returns "line N: <level> <text>" for every heading that repeats an earlier one of the same level.
function duplicateHeadings(md) {
  const seen = new Set();
  const dups = [];
  let fence = null;
  md.split(/\r?\n/).forEach((line, i) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      return;
    }
    if (f) { fence = f[1]; return; }
    const m = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!m) return;
    const key = m[1].length + ' ' + m[2].trim().toLowerCase();
    if (seen.has(key)) dups.push('line ' + (i + 1) + ': ' + m[1] + ' ' + m[2].trim());
    else seen.add(key);
  });
  return dups;
}

test('every docs page has unique headings per level', { skip: !fs.existsSync(docsDir) }, () => {
  const problems = [];
  for (const file of markdownFiles(docsDir)) {
    for (const d of duplicateHeadings(fs.readFileSync(file, 'utf8'))) {
      problems.push(path.relative(repo, file) + ' ' + d);
    }
  }
  assert.deepStrictEqual(problems, []);
});

test('finds a repeated heading of the same level', () => {
  assert.strictEqual(duplicateHeadings('# A\n\n## Setup\n\n## Setup\n').length, 1);
});

test('ignores case and trailing closing hashes when comparing', () => {
  assert.strictEqual(duplicateHeadings('## Setup\n## setup ##\n').length, 1);
});

test('allows the same text at different levels', () => {
  assert.deepStrictEqual(duplicateHeadings('## Setup\n### Setup\n'), []);
});

test('ignores headings inside fenced code blocks', () => {
  const md = '## Run\n```sh\n## Run\n# Run\n```\n~~~\n## Run\n~~~\n';
  assert.deepStrictEqual(duplicateHeadings(md), []);
});

test('a heading after a closed fence still counts', () => {
  assert.strictEqual(duplicateHeadings('## Run\n```\ncode\n```\n## Run\n').length, 1);
});

test('a shorter fence does not close a longer one', () => {
  assert.deepStrictEqual(duplicateHeadings('## Run\n````\n```\n## Run\n````\n'), []);
});

test('scans nested directories of a temporary docs tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-docs-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.md'), '## One\n## Two\n');
    fs.writeFileSync(path.join(dir, 'sub', 'b.md'), '## One\n## One\n');
    fs.writeFileSync(path.join(dir, 'sub', 'c.txt'), '## One\n## One\n');
    const files = markdownFiles(dir).map((f) => path.relative(dir, f));
    assert.deepStrictEqual(files, ['a.md', path.join('sub', 'b.md')]);
    const bad = files.filter((f) => duplicateHeadings(fs.readFileSync(path.join(dir, f), 'utf8')).length);
    assert.deepStrictEqual(bad, [path.join('sub', 'b.md')]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
