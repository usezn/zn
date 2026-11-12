'use strict';

// fromTemporaryCopy tells a temporary copy of zn-gate (npx, pnpm dlx, yarn dlx, bunx) from an install that stays.
// These cases add folder names not covered in init_guide.test.js, each with forward slashes and with backslashes.
// Paths are built inside a temporary directory; the function only looks at the path text.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fromTemporaryCopy } = require('../lib/init-guide');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-temp-copy-')).split(path.sep).join('/');
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const back = (p) => p.replace(/\//g, '\\');
const winBase = 'C:/Users/example/AppData/Local';

function check(rel, expected) {
  for (const root of [base, winBase]) {
    const p = root + '/' + rel;
    assert.equal(fromTemporaryCopy(p), expected, p);
    assert.equal(fromTemporaryCopy(back(p)), expected, back(p));
  }
}

test('an _npx folder is a temporary copy', () => {
  check('npm-cache/_npx/0a1b2c/node_modules/zn-gate/lib', true);
});

test('dlx and dlx-<suffix> folders are temporary copies', () => {
  check('pnpm/dlx/5f3c/node_modules/zn-gate/lib', true);
  check('pnpm/dlx-123/node_modules/zn-gate/lib', true);
});

test('a yarn xfs-<suffix> folder is a temporary copy', () => {
  check('Temp/xfs-abc/dlx-123/node_modules/zn-gate/lib', true);
  check('Temp/xfs-abc/node_modules/zn-gate/lib', true);
});

test('the bun install cache and a bunx-<suffix> folder are temporary copies', () => {
  check('.bun/install/cache/zn-gate@1.0.0/lib', true);
  check('Temp/bunx-123-zn-gate@latest/node_modules/zn-gate/lib', true);
  check('Temp/bunx-123/node_modules/zn-gate/lib', true);
});

test('a normal global folder is not a temporary copy', () => {
  check('npm-global/lib/node_modules/zn-gate/lib', false);
  check('pnpm/global/5/node_modules/zn-gate/lib', false);
  check('.bun/install/global/node_modules/zn-gate/lib', false);
});

test('a folder name that only contains npx, dlx, xfs or bunx is not a temporary copy', () => {
  check('npx/node_modules/zn-gate/lib', false);
  check('my-npx-tools/node_modules/zn-gate/lib', false);
  check('_npx-old/node_modules/zn-gate/lib', false);
  check('mydlx/node_modules/zn-gate/lib', false);
  check('xfs/node_modules/zn-gate/lib', false);
  check('bunx/node_modules/zn-gate/lib', false);
  check('.bun/install/cache-old/zn-gate/lib', false);
});

test('a matching name must be a whole folder with a separator after it', () => {
  assert.equal(fromTemporaryCopy(base + '/_npx'), false);
  assert.equal(fromTemporaryCopy(back(base + '/dlx-123')), false);
  assert.equal(fromTemporaryCopy('_npx/zn-gate/lib'), false);
});
