// Tests of check-docs-reachable.mjs. Run: node --test .github/scripts/check-docs-reachable.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDir, linkTargets, resolveTarget } from './check-docs-reachable.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function tree(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'docreach-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('links are read outside code, in inline and reference form', () => {
  const md = 'See [a](a.md#x) and [b](<sub/b.md>) and `[c](c.md)`.\n\n```\n[d](d.md)\n```\n\n[ref]: e.md\n';
  assert.deepEqual(linkTargets(md), ['a.md#x', 'sub/b.md', 'e.md']);
});

test('targets resolve against the page that holds them', () => {
  assert.equal(resolveTarget('b.md#top', 'sub/a.md'), 'sub/b.md');
  assert.equal(resolveTarget('../c.md', 'sub/a.md'), 'c.md');
  assert.equal(resolveTarget('../../outside.md', 'sub/a.md'), null);
  assert.equal(resolveTarget('https://example.com/x.md', 'a.md'), null);
  assert.equal(resolveTarget('#anchor', 'a.md'), null);
  assert.equal(resolveTarget('image.png', 'a.md'), null);
});

test('pages linked directly or through other pages pass', () => {
  const dir = tree({ 'README.md': '[a](a.md)\n', 'a.md': '[b](sub/b.md)\n', 'sub/b.md': '[home](../README.md)\n' });
  const r = checkDir(dir, {});
  assert.deepEqual(r.unreachable, []);
  assert.equal(r.checked, 3);
});

test('a page nobody links to is reported', () => {
  const dir = tree({ 'README.md': '[a](a.md)\n', 'a.md': 'text\n', 'lonely.md': '[a](a.md)\n' });
  assert.deepEqual(checkDir(dir, {}).unreachable, ['lonely.md']);
});

test('a link from a page that is itself unreachable does not count', () => {
  const dir = tree({ 'README.md': 'nothing\n', 'x.md': '[y](y.md)\n', 'y.md': 'text\n' });
  assert.deepEqual(checkDir(dir, {}).unreachable, ['x.md', 'y.md']);
});

test('a link inside a code block does not count', () => {
  const dir = tree({ 'README.md': '```\n[a](a.md)\n```\n', 'a.md': 'text\n' });
  assert.deepEqual(checkDir(dir, {}).unreachable, ['a.md']);
});

test('an excluded page passes; a stale exclusion is reported', () => {
  const dir = tree({ 'README.md': '[a](a.md)\n', 'a.md': 'text\n', 'draft.md': 'text\n' });
  assert.deepEqual(checkDir(dir, { 'draft.md': 'not published yet' }).unreachable, []);
  const stale = checkDir(dir, { 'draft.md': 'x', 'a.md': 'x', 'gone.md': 'x' }).staleExclusions;
  assert.deepEqual(stale.map((s) => s.page).sort(), ['a.md', 'gone.md']);
});

test('a folder without README.md fails', () => {
  const dir = tree({ 'a.md': 'text\n' });
  assert.equal(checkDir(dir, {}).missingRoot, true);
  const r = spawnSync(process.execPath, [path.join(here, 'check-docs-reachable.mjs'), dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
});

test('the command exits 1 and names the page, and 0 when all pages are linked', () => {
  const bad = tree({ 'README.md': 'text\n', 'lonely.md': 'text\n' });
  const r = spawnSync(process.execPath, [path.join(here, 'check-docs-reachable.mjs'), bad], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lonely\.md/);
  const good = tree({ 'README.md': '[a](a.md)\n', 'a.md': 'text\n' });
  const ok = spawnSync(process.execPath, [path.join(here, 'check-docs-reachable.mjs'), good], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
});

test('the real docs folder has no page that the index cannot reach', () => {
  const root = path.resolve(here, '..', '..', 'docs');
  const r = checkDir(root);
  assert.deepEqual(r.unreachable, []);
  assert.deepEqual(r.staleExclusions, []);
});
