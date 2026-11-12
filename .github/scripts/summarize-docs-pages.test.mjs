// Tests of summarize-docs-pages.mjs. Run: node --test .github/scripts/summarize-docs-pages.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { countPages, summaryText } from './summarize-docs-pages.mjs';

const SCRIPT = fileURLToPath(new URL('./summarize-docs-pages.mjs', import.meta.url));

function tree(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'docpages-'));
  for (const name of Object.keys(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), files[name]);
  }
  return path.join(dir, 'docs');
}

test('pages outside docs/examples and pages inside it are counted apart', () => {
  const docs = tree({
    'docs/a.md': '# A\n',
    'docs/sub/b.md': '# B\n',
    'docs/notes.txt': 'not a page\n',
    'docs/examples/c.md': '# C\n',
    'docs/examples/deep/d.md': '# D\n',
  });
  assert.deepEqual(countPages(docs), { pages: 2, examples: 2 });
});

test('a docs folder without examples counts zero examples', () => {
  assert.deepEqual(countPages(tree({ 'docs/a.md': '# A\n' })), { pages: 1, examples: 0 });
});

test('a file named examples.md is a page, not the examples folder', () => {
  assert.deepEqual(countPages(tree({ 'docs/examples.md': '# E\n' })), { pages: 1, examples: 0 });
});

test('the summary is a table with both counts', () => {
  const text = summaryText({ pages: 12, examples: 3 });
  assert.match(text, /^### Docs pages/);
  assert.match(text, /\| docs \(excluding docs\/examples\) \| 12 \|/);
  assert.match(text, /\| docs\/examples \| 3 \|/);
});

test('the script appends the summary to GITHUB_STEP_SUMMARY when it is set', () => {
  const docs = tree({ 'docs/a.md': '# A\n', 'docs/examples/b.md': '# B\n' });
  const summary = path.join(path.dirname(docs), 'summary.md');
  const r = spawnSync(process.execPath, [SCRIPT, docs], {
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(summary, 'utf8'), summaryText({ pages: 1, examples: 1 }) + '\n');
});

test('without GITHUB_STEP_SUMMARY the table goes to standard output', () => {
  const docs = tree({ 'docs/a.md': '# A\n' });
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  const r = spawnSync(process.execPath, [SCRIPT, docs], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, summaryText({ pages: 1, examples: 0 }));
});
