'use strict';
process.env.ZN_STATS = 'off';

// The three program names in the bin entries of package.json (zn-gate, zn and zn-mcp) start the same file,
// and `version` prints the same text through each of them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const ROOT = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const NAMES = ['zn-gate', 'zn', 'zn-mcp'];

test('package.json has the three program names and each one points to the same existing file', () => {
  assert.deepEqual(Object.keys(pkg.bin).sort(), [...NAMES].sort());
  const targets = new Set(NAMES.map((n) => path.resolve(ROOT, pkg.bin[n])));
  assert.equal(targets.size, 1);
  const [file] = targets;
  assert.ok(fs.statSync(file).isFile());
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node'));
});

test('version prints the same text through each program name', { skip: process.platform === 'win32' }, (t) => {
  const dir = tempDir(t, 'zn-names-');
  const outputs = NAMES.map((name) => {
    const link = path.join(dir, name);
    fs.symlinkSync(path.resolve(ROOT, pkg.bin[name]), link);
    const r = spawnSync(process.execPath, [link, 'version'], { encoding: 'utf8', env: { ...process.env, ZN_STATS: 'off' } });
    assert.equal(r.status, 0, name + ': ' + r.stderr);
    assert.equal(r.stderr, '', name);
    return r.stdout;
  });
  assert.ok(outputs[0].startsWith('zn-gate ' + pkg.version + ' '));
  assert.equal(outputs[1], outputs[0]);
  assert.equal(outputs[2], outputs[0]);
});

test('the bin file path from each entry prints the same version text', () => {
  const outputs = NAMES.map((name) => {
    const r = spawnSync(process.execPath, [path.resolve(ROOT, pkg.bin[name]), 'version'], { encoding: 'utf8' });
    assert.equal(r.status, 0, name);
    return r.stdout;
  });
  assert.equal(new Set(outputs).size, 1);
});
