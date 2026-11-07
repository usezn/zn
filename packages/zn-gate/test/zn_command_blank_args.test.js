'use strict';
// znCommand with empty, blank, non-text and padded arguments, with zn on a
// fake PATH and without it. Fictitious temporary directories only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { znCommand, cliName, PACKAGE_VERSION } = require('../lib/zn-command');

const WIN = process.platform === 'win32';
// On Windows znCommand prints the .cmd shims (zn.cmd, npx.cmd), so expect the same names.
const ZN = cliName('zn');
const NPX = cliName('npx') + ' -y zn-gate@' + PACKAGE_VERSION;

function envWithZn(dir) {
  const file = path.join(dir, WIN ? 'zn.cmd' : 'zn');
  fs.writeFileSync(file, WIN ? '@echo zn\r\n' : '#!/bin/sh\necho zn\n');
  if (!WIN) fs.chmodSync(file, 0o755);
  return WIN ? { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' } : { PATH: dir };
}

function envWithoutZn(dir) {
  return WIN ? { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' } : { PATH: dir };
}

const CASES = [
  ['undefined', undefined, ''],
  ['null', null, ''],
  ['an empty string', '', ''],
  ['only blanks', ' \t \n ', ''],
  ['the number 0', 0, ''],
  ['a non-zero number', 42, '42'],
  ['text with blanks at both ends', '  \t env shadow .env \n ', 'env shadow .env'],
  ['inner blanks kept', ' a   b ', 'a   b'],
];

test('znCommand: odd arguments with zn on PATH', (t) => {
  const env = envWithZn(tempDir(t, 'zn-blank-yes-'));
  for (const [name, arg, tail] of CASES) {
    assert.equal(znCommand(arg, { env }), tail ? ZN + ' ' + tail : ZN, name);
  }
});

test('znCommand: odd arguments without zn on PATH carry the package version', (t) => {
  const env = envWithoutZn(tempDir(t, 'zn-blank-no-'));
  for (const [name, arg, tail] of CASES) {
    const got = znCommand(arg, { env });
    assert.equal(got, tail ? NPX + ' ' + tail : NPX, name);
    assert.ok(got.includes('@' + PACKAGE_VERSION), name);
    assert.equal(got, got.trim(), name);
  }
});
