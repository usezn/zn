// Tests of check-docs-examples-index-targets.mjs. Run: node --test .github/scripts/check-docs-examples-index-targets.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { entries, missingTargets } from './check-docs-examples-index-targets.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-docs-examples-index-targets.mjs');

function folder(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examples-index-'));
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

const entry = (name) => `- [${name}](${name}): text.\n`;

test('entries are read with their names, targets and lines', () => {
  const r = entries('# Examples\n\n' + entry('a.md') + entry('b.md'));
  assert.deepEqual(r, [
    { name: 'a.md', target: 'a.md', line: 3 },
    { name: 'b.md', target: 'b.md', line: 4 },
  ]);
});

test('entries inside a code fence are ignored', () => {
  assert.deepEqual(entries('```md\n' + entry('a.md') + '```\n'), []);
});

test('an index whose pages all exist has no missing targets', () => {
  const dir = folder({ 'a.md': '', 'b.md': '', 'README.md': entry('a.md') + entry('b.md') });
  assert.deepEqual(missingTargets(entry('a.md') + entry('b.md'), dir), []);
});

test('each missing target is reported with its entry and line', () => {
  const dir = folder({ 'a.md': '' });
  const text = '# Examples\n\n' + entry('a.md') + entry('gone.md') + entry('also-gone.md');
  assert.deepEqual(missingTargets(text, dir), [
    { name: 'gone.md', target: 'gone.md', line: 4 },
    { name: 'also-gone.md', target: 'also-gone.md', line: 5 },
  ]);
});

test('a target that is a folder, not a page, is missing', () => {
  const dir = folder({ 'sub/x.md': '' });
  assert.equal(missingTargets('- [sub](sub): text.\n', dir).length, 1);
});

test('an anchor or a path that leaves the folder is not a page', () => {
  const dir = folder({ 'a.md': '', 'README.md': '' });
  const text = '- [x](#top): text.\n- [y](../README.md): text.\n- [z](a.md#part): text.\n';
  assert.deepEqual(missingTargets(text, dir).map((e) => e.target), ['#top', '../README.md']);
});

test('an encoded file name is decoded before the check', () => {
  const dir = folder({ 'my page.md': '' });
  assert.deepEqual(missingTargets('- [p](my%20page.md): text.\n', dir), []);
});

test('the command exits 1 and lists the missing page', () => {
  const dir = folder({ 'README.md': entry('gone.md'), 'a.md': '' });
  const run = spawnSync(process.execPath, [script, path.join(dir, 'README.md')], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /README\.md:1: entry "gone\.md" points to "gone\.md"/);
});

test('the command exits 1 when the index has no entries', () => {
  const dir = folder({ 'README.md': '# Examples\n\nNo pages yet.\n' });
  const run = spawnSync(process.execPath, [script, path.join(dir, 'README.md')], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no entries found/);
});

test('the command exits 0 when every entry points to a page', () => {
  const dir = folder({ 'README.md': entry('a.md'), 'a.md': '' });
  const run = spawnSync(process.execPath, [script, path.join(dir, 'README.md')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /1 entries/);
});
