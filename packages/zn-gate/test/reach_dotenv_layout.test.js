'use strict';

// zn-gate reach: which .env files of a project are found (top folder only, no node_modules,
// links not followed) and where the reach memory file lives. Fake values, temporary folders.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { _internal } = require('../lib/reach');
const { tempDir } = require('./helpers/tmp');

const FAKE = (n) => 'zn-test-fake-value-' + String(n).padStart(4, '0') + '-not-real';

test('dotenvFiles finds .env, .env.local and .env.production in sorted order', (t) => {
  const root = tempDir(t, 'zn-dotenv-layout-');
  fs.writeFileSync(path.join(root, '.env.production'), 'PROD_API_KEY=' + FAKE(1) + '\n');
  fs.writeFileSync(path.join(root, '.env'), 'APP_API_KEY=' + FAKE(2) + '\n');
  fs.writeFileSync(path.join(root, '.env.local'), 'LOCAL_API_KEY=' + FAKE(3) + '\n');
  const files = _internal.dotenvFiles(root);
  assert.deepEqual(files.map((f) => f.file), ['.env', '.env.local', '.env.production']);
  assert.deepEqual(files.map((f) => f.secrets), [['APP_API_KEY'], ['LOCAL_API_KEY'], ['PROD_API_KEY']]);
  assert.ok(files.every((f) => f.markers === 0 && !f.link));
});

test('dotenvFiles ignores .env files in a nested folder and in node_modules', (t) => {
  const root = tempDir(t, 'zn-dotenv-layout-');
  fs.writeFileSync(path.join(root, '.env'), 'APP_API_KEY=' + FAKE(4) + '\n');
  for (const dir of ['packages/app', 'node_modules/pkg', 'node_modules']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, '.env'), 'OTHER_API_KEY=' + FAKE(5) + '\n');
  }
  fs.writeFileSync(path.join(root, 'node_modules', '.env.local'), 'OTHER_API_KEY=' + FAKE(6) + '\n');
  const files = _internal.dotenvFiles(root);
  assert.deepEqual(files.map((f) => f.file), ['.env']);
  assert.deepEqual(files[0].secrets, ['APP_API_KEY']);
});

test('dotenvFiles does not follow a link that points outside the project', { skip: process.platform === 'win32' }, (t) => {
  const root = tempDir(t, 'zn-dotenv-layout-');
  const outside = tempDir(t, 'zn-dotenv-outside-');
  const target = path.join(outside, 'real.env');
  fs.writeFileSync(target, 'OUTSIDE_API_KEY=' + FAKE(7) + '\n');
  fs.symlinkSync(target, path.join(root, '.env.production'));
  fs.writeFileSync(path.join(root, '.env'), 'APP_API_KEY=' + FAKE(8) + '\n');
  const files = _internal.dotenvFiles(root);
  assert.deepEqual(files.map((f) => f.file), ['.env', '.env.production']);
  assert.deepEqual(files[1], { file: '.env.production', secrets: [], markers: 0, link: true });
  assert.ok(!JSON.stringify(files).includes('OUTSIDE_API_KEY'));
});

test('memoryFile is under ~/.zn by default and under ZN_HOME when it is set', (t) => {
  const home = tempDir(t, 'zn-dotenv-home-');
  assert.equal(_internal.memoryFile(home, {}), path.join(home, '.zn', 'reach-last.json'));
  assert.equal(_internal.memoryFile(home, { ZN_HOME: '' }), path.join(home, '.zn', 'reach-last.json'));
  const custom = path.join(home, 'custom');
  assert.equal(_internal.memoryFile(home, { ZN_HOME: custom }), path.join(custom, 'reach-last.json'));
});
