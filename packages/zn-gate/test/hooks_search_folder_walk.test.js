'use strict';

process.env.ZN_STATS = 'off';

// The search-folder check looks in the subfolders too, within bounds, and asks when it cannot finish.
// Only fictitious values: empty files and a fake .env in temporary folders.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runner = require('../lib/hooks/runner');
const realEngine = require('../lib/scrub/engine');
const { createFakeVault } = require('./helpers/fake_vault');
const { tempDir } = require('./helpers/tmp');

async function search(dir, t) {
  const ev = { event: 'pre_tool', tool: 'grep', toolName: 'Grep', cwd: dir, input: { pattern: 'x', scanDir: dir } };
  const d = { engine: () => realEngine, vault: async () => createFakeVault(), detectors: () => [] };
  return runner.decidePre(ev, d, 'claude-code', { failMode: 'open', home: tempDir(t, 'zn-sfw-home-') });
}

function touch(f, body = '') {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}

test('a folder of ordinary files is allowed', async (t) => {
  const dir = tempDir(t, 'zn-sfw-');
  touch(path.join(dir, 'a.txt'));
  touch(path.join(dir, 'src', 'deep', 'b.js'));
  assert.equal((await search(dir, t)).decision, 'allow');
});

test('a .env in a subfolder asks', async (t) => {
  const dir = tempDir(t, 'zn-sfw-');
  touch(path.join(dir, 'src', 'a', 'b', '.env'), 'FAKE_KEY=not-a-real-value\n');
  const res = await search(dir, t);
  assert.equal(res.decision, 'ask');
  assert.match(res.message, /\.env/);
});

test('a .env after the 5000th name of the top level asks', async (t) => {
  const dir = tempDir(t, 'zn-sfw-');
  for (let i = 0; i < 5200; i++) fs.writeFileSync(path.join(dir, 'f' + String(i).padStart(5, '0') + '.txt'), '');
  fs.writeFileSync(path.join(dir, 'zzz.env'), 'FAKE_KEY=not-a-real-value\n');
  fs.writeFileSync(path.join(dir, '.env'), 'FAKE_KEY=not-a-real-value\n');
  assert.equal((await search(dir, t)).decision, 'ask');
});

test('more names than the walk reads asks', async (t) => {
  const dir = tempDir(t, 'zn-sfw-');
  for (let i = 0; i < 10100; i++) fs.writeFileSync(path.join(dir, 'f' + i + '.txt'), '');
  const res = await search(dir, t);
  assert.equal(res.decision, 'ask');
  assert.match(res.message, /cannot check/);
});

test('more levels than the walk reads asks', async (t) => {
  const dir = tempDir(t, 'zn-sfw-');
  touch(path.join(dir, 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10', 'a.txt'));
  const res = await search(dir, t);
  assert.equal(res.decision, 'ask');
  assert.match(res.message, /cannot check/);
});

test('node_modules and .git are not walked', async (t) => {
  const dir = tempDir(t, 'zn-sfw-');
  touch(path.join(dir, 'a.txt'));
  touch(path.join(dir, 'node_modules', 'pkg', '.env'), 'FAKE_KEY=not-a-real-value\n');
  touch(path.join(dir, '.git', 'x', '.env'), 'FAKE_KEY=not-a-real-value\n');
  assert.equal((await search(dir, t)).decision, 'allow');
});

test('a symlink to a folder is not followed', async (t) => {
  const dir = tempDir(t, 'zn-sfw-');
  const other = tempDir(t, 'zn-sfw-other-');
  touch(path.join(other, '.env'), 'FAKE_KEY=not-a-real-value\n');
  touch(path.join(dir, 'a.txt'));
  try { fs.symlinkSync(other, path.join(dir, 'link'), 'dir'); } catch (_) { return; }
  assert.equal((await search(dir, t)).decision, 'allow');
});

test('the walk of a typical tree is fast', async (t) => {
  const dir = tempDir(t, 'zn-sfw-');
  for (let d = 0; d < 40; d++) for (let i = 0; i < 25; i++) touch(path.join(dir, 'd' + d, 'e' + (i % 5), 'f' + i + '.js'));
  const t0 = process.hrtime.bigint();
  assert.equal((await search(dir, t)).decision, 'allow');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, 'took ' + ms + ' ms');
});
