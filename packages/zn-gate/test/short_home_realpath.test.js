'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const files = require('../lib/broker/files');

// Windows writes the profile of "Jose Perez" (with accents or a space) as JOSPRE~1: the short name is not a prefix of the
// long one, so the text alone cannot say which protected folder AWS~1 or CLAUDE~1 stands for. The native real path of the
// file on Windows gives the long name, and the protected-path rules read it as one more candidate.
function winTree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-short-'));
  const home = path.join(dir, 'José Pérez');
  const short = path.join(dir, 'JOSPRE~1', 'AWS~1', 'CREDEN~1');
  const long = path.join(home, '.aws', 'credentials');
  fs.mkdirSync(path.dirname(short), { recursive: true });
  fs.writeFileSync(short, 'x');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const realpath = (p) => (p === short ? long : fs.realpathSync.native(p));
  return { dir, home, short, long, realpath };
}

test('on win32 nativeTargetOf returns the long name of a short-named file', (t) => {
  const { short, long, realpath } = winTree(t);
  assert.strictEqual(files.nativeTargetOf(short, { platform: 'win32', realpath }), long);
});

test('realTargetOf does not use the native call, so approved locations compare the same way as before', (t) => {
  const { short } = winTree(t);
  assert.strictEqual(files.realTargetOf(short), fs.realpathSync(short));
});

test('off win32 nativeTargetOf is the same as realTargetOf and does not use the native call', (t) => {
  const { short } = winTree(t);
  let called = false;
  const realpath = (p) => { called = true; return p; };
  assert.strictEqual(files.nativeTargetOf(short, { platform: 'linux', realpath }), files.realTargetOf(short));
  assert.strictEqual(called, false);
});

test('on a real Windows host nativeTargetOf of the temp folder is an existing long path', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-short-'));
  try {
    const target = files.nativeTargetOf(dir);
    assert.ok(!target.includes('~'), target);
    assert.strictEqual(fs.realpathSync.native(target).toLowerCase(), target.toLowerCase());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
