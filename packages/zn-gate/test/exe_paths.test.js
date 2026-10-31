'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { approvalPath, writableBy } = require('../lib/exe');

const isWin = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const posixOnly = { skip: isWin ? 'POSIX only' : false };
const posixNonRoot = { skip: isWin ? 'POSIX only' : isRoot ? 'root can write everywhere' : false };

function tempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-exe-paths-')));
}

test('writableBy: empty input gives null', () => {
  assert.equal(writableBy(''), null);
  assert.equal(writableBy(undefined), null);
});

test('writableBy: a file owned by the current user is reported as itself', posixOnly, () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'tool');
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(writableBy(file), file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writableBy: a read-only file in a read-only folder reports the first writable folder above', posixNonRoot, () => {
  const top = tempDir();
  const ro = path.join(top, 'ro');
  try {
    fs.mkdirSync(ro);
    const file = path.join(ro, 'tool');
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o555 });
    fs.chmodSync(ro, 0o555);
    assert.equal(writableBy(file), top);
  } finally {
    fs.chmodSync(ro, 0o755);
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test('writableBy: a read-only file in a writable folder reports the folder', posixNonRoot, () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'tool');
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o555 });
    assert.equal(writableBy(file), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('approvalPath: a real path keeps its shape on POSIX', posixOnly, () => {
  const p = '/opt/Example/bin/Tool';
  assert.equal(approvalPath(p), p);
});

test('approvalPath: a real path is lower-cased on Windows', { skip: isWin ? false : 'Windows only' }, () => {
  assert.equal(approvalPath('C:\\Example\\Bin\\Tool.EXE'), 'c:\\example\\bin\\tool.exe');
});

test('approvalPath: the path of a temporary file is returned as a string, unchanged apart from case', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'Tool');
    fs.writeFileSync(file, '');
    const real = fs.realpathSync(file);
    const out = approvalPath(real);
    assert.equal(typeof out, 'string');
    assert.equal(out, isWin ? real.toLowerCase() : real);
    assert.equal(path.isAbsolute(out), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
