// Tests of check-docs-no-simply-just.mjs. Run: node --test .github/scripts/check-docs-no-simply-just.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDir, findHits, MESSAGE, warningLine } from './check-docs-no-simply-just.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'check-docs-no-simply-just.mjs');

test('the word before an inline command is flagged', () => {
  assert.equal(findHits('Then just `npm test` to check it.\n').length, 1);
  assert.equal(findHits('Simply `zn init` and go.\n').length, 1);
});

test('an imperative after the start of a sentence or list item is flagged', () => {
  assert.equal(findHits('Just run the installer.\n').length, 1);
  assert.equal(findHits('- Simply type the name.\n').length, 1);
  assert.equal(findHits('1. just open the file\n').length, 1);
  assert.equal(findHits('Install it first. Then just run the check.\n').length, 1);
});

test('other uses of the words are not flagged', () => {
  const ok = [
    'Run this step just once.',
    'If you just run it again, nothing changes.',
    'You have just run `zn hooks install <agent>`, to confirm the hooks.',
    'A file that was just created is listed.',
    'Nothing secret here, just a plan for the demo.',
    'To do just this step, use the command below.',
    'This is just a flag: `--json`.',
  ];
  for (const line of ok) assert.deepEqual(findHits(line + '\n'), [], line);
});

test('a quoted example of the wording is not flagged', () => {
  assert.deepEqual(findHits('Do not write "Avoid: just run the tool" in docs.\n'), []);
});

test('code blocks and inline code are not read as prose', () => {
  assert.deepEqual(findHits('```sh\njust run the thing\n```\n'), []);
  assert.deepEqual(findHits('Use `just run` in a script.\n'), []);
});

test('each flagged line is reported with its number', () => {
  const hits = findHits('# A\n\nJust run `zn init`.\n\nFine line.\n');
  assert.deepEqual(hits, [{ n: 3, text: 'Just run `zn init`.' }]);
});

function tree(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'docsimply-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('checkDir reports the file and line of each hit and counts the pages', () => {
  const dir = tree({ 'a.md': '# A\n', 'sub/b.md': 'Simply run it.\n', 'c.md': 'Plain text.\n' });
  const r = checkDir(dir);
  assert.equal(r.checked, 3);
  assert.deepEqual(r.hits, [{ file: r.hits[0].file, n: 1, text: 'Simply run it.' }]);
  assert.match(r.hits[0].file, /sub\/b\.md$/);
});

test('the warning annotation names the file and the line', () => {
  assert.equal(warningLine('docs/a.md', 3), `::warning file=docs/a.md,line=3::${MESSAGE}`);
});

test('default mode prints a GitHub warning per hit and exits 0', () => {
  const dir = tree({ 'docs/a.md': 'Just run `zn init`.\n', 'docs/b.md': '# B\n' });
  const r = spawnSync(process.execPath, [script, 'docs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('::warning file=docs/a.md,line=1::'), r.stdout);
  assert.ok(!r.stdout.includes('::warning file=docs/b.md'), r.stdout);
});

test('default mode with no hits prints OK and exits 0', () => {
  const dir = tree({ 'docs/a.md': '# A\n' });
  const r = spawnSync(process.execPath, [script, 'docs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /docs simply\/just OK/);
});

test('--strict prints each hit as an error and exits 1', () => {
  const dir = tree({ 'docs/a.md': 'Just run `zn init`.\n' });
  const r = spawnSync(process.execPath, [script, '--strict', 'docs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('docs/a.md:1: Just run `zn init`.'), r.stderr);
  assert.ok(!r.stdout.includes('::warning'), r.stdout);
});

test('--strict with no hits exits 0', () => {
  const dir = tree({ 'docs/a.md': '# A\n' });
  const r = spawnSync(process.execPath, [script, '--strict', 'docs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
