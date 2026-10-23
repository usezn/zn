'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('../lib/hooks/policy');
const files = require('../lib/broker/files');

// Windows writes the profile of "Jose Perez" (with accents or a space) as JOSPRE~1: the short name is not a prefix of the
// long one, so the text alone cannot say which protected folder AWS~1 or CLAUDE~1 stands for. The real path of the file
// (the native call on Windows) gives the long name, and the rules read that.
function winTree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-short-'));
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const realNative = fs.realpathSync.native;
  const home = path.join(dir, 'José Pérez');
  const short = path.join(dir, 'JOSPRE~1', 'AWS~1', 'CREDEN~1');
  const long = path.join(home, '.aws', 'credentials');
  fs.mkdirSync(path.dirname(short), { recursive: true });
  fs.writeFileSync(short, 'x');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  fs.realpathSync.native = (p) => (p === short ? long : realNative(p));
  t.after(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    fs.realpathSync.native = realNative;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, home, short, long };
}

test('on win32 realTargetOf returns the long name of a short-named file', (t) => {
  const { short, long } = winTree(t);
  assert.strictEqual(files.realTargetOf(short), long);
});

test('on win32 a read through the short home and short folder names is blocked', (t) => {
  const { dir, home, short } = winTree(t);
  assert.ok(policy.readDenial(short, { cwd: dir, home, env: {} }));
});

test('off win32 realTargetOf does not use the native call', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-short-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const realNative = fs.realpathSync.native;
  let called = false;
  fs.realpathSync.native = (p) => { called = true; return realNative(p); };
  t.after(() => { fs.realpathSync.native = realNative; });
  files.realTargetOf(dir);
  if (process.platform !== 'win32') assert.strictEqual(called, false);
});
