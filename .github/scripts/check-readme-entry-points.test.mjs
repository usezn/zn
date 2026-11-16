// Tests of check-readme-entry-points.mjs. Run: node --test .github/scripts/check-readme-entry-points.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ENTRY_POINTS, checkRepo, linksFromDocsIndex, linksFromRootReadme } from './check-readme-entry-points.mjs';

const rootLinks = (names) => names.map((n) => `[page](docs/${n})`).join(' ');
const indexLinks = (names) => names.map((n) => `[page](${n})`).join(' ');

function repo(rootText, indexText, pages = ENTRY_POINTS) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'readme-entry-'));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'README.md'), rootText);
  fs.writeFileSync(path.join(dir, 'docs', 'README.md'), indexText);
  for (const p of pages) fs.writeFileSync(path.join(dir, 'docs', p), '# page\n');
  return dir;
}

test('the root README links are the docs/<name>.md targets, with or without an anchor', () => {
  const text = 'See [CLI](docs/cli.md#flags), [Index](docs/README.md) and [Example](docs/examples/x.md).\n';
  assert.deepEqual([...linksFromRootReadme(text)].sort(), ['README.md', 'cli.md']);
});

test('the docs index links are the <name>.md targets, with or without ./', () => {
  const text = '[CLI](cli.md) [Check](./check.md#x) [Root](../README.md) [Example](examples/y.md)\n';
  assert.deepEqual([...linksFromDocsIndex(text)].sort(), ['check.md', 'cli.md']);
});

test('a repository where both files link every entry point passes', () => {
  const dir = repo(rootLinks(ENTRY_POINTS), indexLinks(ENTRY_POINTS));
  try {
    assert.deepEqual(checkRepo(dir).problems, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('removing one link from the root README fails and names the page', () => {
  const dir = repo(rootLinks(ENTRY_POINTS.filter((n) => n !== 'cli.md')), indexLinks(ENTRY_POINTS));
  try {
    assert.deepEqual(checkRepo(dir).problems, [{ file: 'README.md', page: 'cli.md', reason: 'does not link docs/cli.md' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('removing one link from the docs index fails and names the page', () => {
  const dir = repo(rootLinks(ENTRY_POINTS), indexLinks(ENTRY_POINTS.filter((n) => n !== 'troubleshooting.md')));
  try {
    assert.deepEqual(checkRepo(dir).problems, [{ file: 'docs/README.md', page: 'troubleshooting.md', reason: 'does not link troubleshooting.md' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an entry point whose page is missing from docs/ fails', () => {
  const dir = repo(rootLinks(ENTRY_POINTS), indexLinks(ENTRY_POINTS), ENTRY_POINTS.filter((n) => n !== 'secrets.md'));
  try {
    assert.deepEqual(checkRepo(dir).problems, [{ file: 'docs', page: 'secrets.md', reason: 'docs/secrets.md does not exist' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a page that only one file links is not an entry point', () => {
  const dir = repo(rootLinks(ENTRY_POINTS) + ' [faq](docs/faq.md)', indexLinks(ENTRY_POINTS) + ' [faq](faq.md)');
  try {
    assert.deepEqual(checkRepo(dir).problems, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
