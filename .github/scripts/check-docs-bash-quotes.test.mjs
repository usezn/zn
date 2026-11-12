// Tests of check-docs-bash-quotes.mjs. Run: node --test .github/scripts/check-docs-bash-quotes.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkRoot, curlyQuoteProblems, listPages, shellBlockLines } from './check-docs-bash-quotes.mjs';

const Q = {
  lsq: '‘', rsq: '’', ldq: '“', rdq: '”',
};

test('only bash, sh, shell and console blocks are shell blocks, in any letter case', () => {
  const md = [
    '```bash', 'a', '```',
    '```SH', 'b', '```',
    '```shell title=x', 'c', '```',
    '```Console', 'd', '```',
    '```json', 'e', '```',
    '```', 'f', '```',
    '~~~zsh', 'g', '~~~',
    'prose',
  ].join('\n');
  assert.deepEqual(shellBlockLines(md).map((l) => l.text), ['a', 'b', 'c', 'd']);
});

test('a closing fence must use the same character and at least the same length', () => {
  const md = '````sh\n```\nstill code\n````\nafter\n~~~bash\n```\nstill shell\n~~~\n';
  assert.deepEqual(shellBlockLines(md).map((l) => l.text), ['```', 'still code', '```', 'still shell']);
});

test('a curly quote in a shell block is reported with its line and code point', () => {
  const md = 'Intro\n\n```bash\necho ' + Q.ldq + 'hi' + Q.rdq + '\n```\n';
  const p = curlyQuoteProblems('docs/a.md', md);
  assert.equal(p.length, 1);
  assert.equal(p[0].line, 4);
  assert.equal(p[0].codePoint, 'U+201C');
  assert.equal(p[0].file, 'docs/a.md');
});

test('every curly quote character is caught', () => {
  for (const q of Object.values(Q)) {
    assert.equal(curlyQuoteProblems('a.md', '```sh\nx ' + q + '\n```\n').length, 1);
  }
});

test('curly quotes in prose, JSON blocks and straight quotes in shell blocks pass', () => {
  const md = 'It' + Q.rsq + 's fine ' + Q.ldq + 'here' + Q.rdq + '.\n\n```json\n{"a": "' + Q.ldq + 'x' + Q.rdq + '"}\n```\n\n```bash\necho "it\'s fine"\n```\n';
  assert.deepEqual(curlyQuoteProblems('a.md', md), []);
});

function tree(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'docbashq-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('the rule covers docs/**/*.md and README.md and nothing else', () => {
  const bad = '```bash\nx ' + Q.rsq + '\n```\n';
  const dir = tree({
    'README.md': bad,
    'docs/a.md': '# A\n',
    'docs/sub/b.md': bad,
    'packages/zn-gate/README.md': bad,
    'CHANGELOG.md': bad,
    'docs/notes.txt': bad,
  });
  try {
    assert.deepEqual(listPages(dir), ['README.md', 'docs/a.md', 'docs/sub/b.md']);
    const r = checkRoot(dir);
    assert.equal(r.checked, 3);
    assert.deepEqual(r.problems.map((p) => p.file), ['README.md', 'docs/sub/b.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the repository docs and README pass', () => {
  const repo = path.resolve(import.meta.dirname, '..', '..');
  const r = checkRoot(repo);
  assert.deepEqual(r.problems, []);
});
