'use strict';
// policy.js denies mkfs on a block device and allows mkdir -p inside a project
// folder, with no setting changed. Device and paths are fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const policy = require('../lib/hooks/policy');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('policy denies mkfs on a block device', () => {
  const dir = tempDir('zn-policy-mkfs-');
  const home = tempDir('zn-policy-home-');
  try {
    const denial = policy.bashDenial('mkfs.ext4 /dev/sdz', { cwd: dir, home });
    assert.ok(denial, 'mkfs.ext4 /dev/sdz was not denied');
    assert.ok(denial.startsWith('zn blocked this: '), denial);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('policy allows mkdir -p build/out inside the project', () => {
  const dir = tempDir('zn-policy-mkdir-');
  const home = tempDir('zn-policy-home-');
  try {
    assert.equal(policy.bashDenial('mkdir -p build/out', { cwd: dir, home }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
