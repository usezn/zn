'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { znCommand, znOnPath, PACKAGE_VERSION } = require('../lib/zn-command');

const isWin = process.platform === 'win32';
const npx = 'npx -y zn-gate@' + PACKAGE_VERSION;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zn-command-'));
}

// A fake program named like the platform expects: zn.cmd on Windows, zn elsewhere.
function fakeZn(dir, mode) {
  const file = path.join(dir, isWin ? 'zn.cmd' : 'zn');
  fs.writeFileSync(file, isWin ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n');
  if (!isWin) fs.chmodSync(file, mode === undefined ? 0o755 : mode);
  return file;
}

function envFor(dirs) {
  return { PATH: dirs.join(path.delimiter), PATHEXT: '.COM;.EXE;.BAT;.CMD' };
}

test('uses the short form when zn is on PATH', () => {
  const dir = tempDir();
  try {
    fakeZn(dir);
    const env = envFor([dir]);
    assert.equal(znOnPath(env), true);
    assert.equal(znCommand('env shadow .env', { env }), 'zn env shadow .env');
    assert.equal(znCommand('', { env }), 'zn');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('falls back to npx with the package version when zn is missing', () => {
  const dir = tempDir();
  try {
    const env = envFor([dir]);
    assert.equal(znOnPath(env), false);
    assert.equal(znCommand('env shadow .env', { env }), npx + ' env shadow .env');
    assert.equal(znCommand(undefined, { env }), npx);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trims the arguments and treats blank arguments as none', () => {
  const env = envFor([]);
  assert.equal(znCommand('  status  ', { env }), npx + ' status');
  assert.equal(znCommand('   ', { env }), npx);
  assert.equal(znCommand(null, { env }), npx);
});

test('ignores relative and empty PATH entries', () => {
  const dir = tempDir();
  const cwd = process.cwd();
  try {
    fakeZn(dir);
    process.chdir(dir);
    const env = { PATH: ['.', '', 'bin'].join(path.delimiter), PATHEXT: '.CMD' };
    assert.equal(znOnPath(env), false);
    assert.equal(znCommand('status', { env }), npx + ' status');
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('finds zn in a later absolute PATH entry', () => {
  const empty = tempDir();
  const dir = tempDir();
  try {
    fakeZn(dir);
    const env = envFor([empty, dir]);
    assert.equal(znCommand('status', { env }), 'zn status');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('accepts the Path spelling of the variable', () => {
  const dir = tempDir();
  try {
    fakeZn(dir);
    const env = { Path: dir, PATHEXT: '.CMD' };
    assert.equal(znOnPath(env), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that is not executable does not count on POSIX', { skip: isWin }, () => {
  const dir = tempDir();
  try {
    fakeZn(dir, 0o644);
    const env = envFor([dir]);
    assert.equal(znOnPath(env), false);
    assert.equal(znCommand('status', { env }), npx + ' status');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an extensionless zn is not a program on Windows', { skip: !isWin }, () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'zn'), '#!/bin/sh\n');
    assert.equal(znOnPath(envFor([dir])), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the exported version matches package.json', () => {
  assert.equal(PACKAGE_VERSION, require('../package.json').version);
});
