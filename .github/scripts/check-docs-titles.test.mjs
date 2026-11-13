// Tests of check-docs-titles.mjs. Run: node --test .github/scripts/check-docs-titles.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDir, firstTitle } from './check-docs-titles.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('the first H1 is the title', () => {
  assert.equal(firstTitle('intro\n\n# Install  \n\n# Later\n'), 'Install');
});

test('an H1 inside a fenced code block is ignored', () => {
  assert.equal(firstTitle('```sh\n# comment\n```\n~~~\n# also code\n~~~\n# Real\n'), 'Real');
  assert.equal(firstTitle('````md\n```\n# nested\n```\n# still code\n````\n# Real\n'), 'Real');
});

test('lower levels and missing titles give null', () => {
  assert.equal(firstTitle('## Two\n### Three\n#nospace\n'), null);
});

test('closing hashes are dropped', () => {
  assert.equal(firstTitle('# Title #\n'), 'Title');
});

function tree(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'doctitles-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('distinct titles pass', () => {
  const dir = tree({ 'a.md': '# A\n', 'sub/b.md': '# B\n', 'c.md': 'no title\n' });
  const r = checkDir(dir);
  assert.equal(r.checked, 3);
  assert.deepEqual(r.duplicates, []);
});

test('the same title in two files fails, ignoring case and spacing, across folders', () => {
  const dir = tree({ 'a.md': '# Install Guide\n', 'sub/b.md': '#   install guide  \n', 'c.md': '# Other\n' });
  const r = checkDir(dir);
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.duplicates[0].files.length, 2);
});

test('a title that appears only in a code block does not collide', () => {
  const dir = tree({ 'a.md': '# A\n', 'b.md': '```\n# A\n```\n# B\n' });
  assert.deepEqual(checkDir(dir).duplicates, []);
});

test('the script runs when started through a symlinked directory', () => {
  const fixture = tree({ 'a.md': '# Same\n', 'b.md': '# Same\n' });
  const linkRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'doctitles-link-'));
  const link = path.join(linkRoot, 'scripts');
  fs.symlinkSync(here, link, process.platform === 'win32' ? 'junction' : 'dir');
  const r = spawnSync(process.execPath, [path.join(link, 'check-docs-titles.mjs'), fixture], { encoding: 'utf8' });
  assert.equal(r.status, 1, `the duplicate title must fail the check:\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /first-level title/);
});
