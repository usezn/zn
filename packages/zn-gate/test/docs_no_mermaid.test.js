'use strict';
// Diagrams in the docs are SVG files with an .excalidraw source, so no page may contain a
// mermaid code fence. Reads the docs folder and the three READMEs (repository, npm, PyPI).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..', '..');
const docsDir = path.join(repo, 'docs');
const readmes = [
  path.join(repo, 'README.md'),
  path.join(repo, 'packages', 'zn-gate', 'README.md'),
  path.join(repo, 'packages', 'zn-gate-py', 'README.md'),
];
const present = fs.existsSync(docsDir) && readmes.every((f) => fs.existsSync(f));

function markdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const FENCE = /^```\s*mermaid/i;

test('no mermaid code fence in docs or READMEs', { skip: !present && 'repository docs are not in this checkout' }, () => {
  const offenders = [];
  for (const file of [...markdownFiles(docsDir), ...readmes]) {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (FENCE.test(line)) offenders.push(`${path.relative(repo, file)}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(offenders, [], `mermaid fences found (use SVG diagrams): ${offenders.join(', ')}`);
});
