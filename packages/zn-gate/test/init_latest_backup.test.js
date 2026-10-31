'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Temporary HOME so nothing outside the temp folder is touched.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-latest-bak-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.on('exit', () => fs.rmSync(FAKE_HOME, { recursive: true, force: true }));
const { latestBackup } = require('../lib/init');

function setup(fn) {
  const dir = fs.mkdtempSync(path.join(FAKE_HOME, 'case-'));
  try { fn(dir, path.join(dir, 'mcp.json')); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('latestBackup returns null when there are no backups', () => {
  setup((dir, f) => {
    assert.equal(latestBackup(f), null);
    fs.writeFileSync(f, '{}');
    assert.equal(latestBackup(f), null);
  });
});

test('latestBackup returns null when the folder does not exist', () => {
  assert.equal(latestBackup(path.join(FAKE_HOME, 'missing', 'mcp.json')), null);
});

test('latestBackup returns the only backup', () => {
  setup((dir, f) => {
    fs.writeFileSync(f + '.bak.1700000000000', '{}');
    assert.equal(latestBackup(f), f + '.bak.1700000000000');
  });
});

test('latestBackup picks the largest timestamp whatever the creation order', () => {
  setup((dir, f) => {
    for (const t of ['1700000000500', '1700000000900', '1700000000100']) fs.writeFileSync(f + '.bak.' + t, '{}');
    assert.equal(latestBackup(f), f + '.bak.1700000000900');
  });
});

test('latestBackup compares timestamps as numbers, not as text', () => {
  setup((dir, f) => {
    fs.writeFileSync(f + '.bak.99', '{}');
    fs.writeFileSync(f + '.bak.100', '{}');
    assert.equal(latestBackup(f), f + '.bak.100');
  });
});

test('latestBackup ignores names that are not ours', () => {
  setup((dir, f) => {
    fs.writeFileSync(f + '.bak.1700000000000', '{}');
    for (const n of ['mcp.json.bak.', 'mcp.json.bak.9999999999999x', 'mcp.json.bak.9999999999999.old',
      'mcp.json.backup.9999999999999', 'other.json.bak.9999999999999', 'mcp.json.9999999999999']) {
      fs.writeFileSync(path.join(dir, n), '{}');
    }
    fs.mkdirSync(f + '.bak.9999999999998');
    assert.equal(latestBackup(f), f + '.bak.1700000000000');
  });
});

test('latestBackup returns null when only foreign names exist', () => {
  setup((dir, f) => {
    fs.writeFileSync(f + '.bak.old', '{}');
    fs.writeFileSync(path.join(dir, 'other.json.bak.1700000000000'), '{}');
    assert.equal(latestBackup(f), null);
  });
});
