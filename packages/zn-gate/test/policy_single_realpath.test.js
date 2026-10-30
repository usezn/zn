'use strict';

// Off Windows a candidate path is resolved once: nativeTargetOf is the same walk as realTargetOf there, so the policy
// reuses the realTargetOf result instead of paying for a second realpath per candidate (Linux and macOS hook latency).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const files = require('../lib/broker/files');
const policy = require('../lib/hooks/policy');

// Counts the realpath calls made by fn. The native variant is counted apart: it is the call Windows pays for.
function countRealpaths(fn) {
  const original = fs.realpathSync;
  const native = original.native;
  const counts = { plain: 0, native: 0 };
  const stub = function (p, ...rest) { counts.plain++; return original.call(fs, p, ...rest); };
  stub.native = function (p, ...rest) { counts.native++; return native.call(fs, p, ...rest); };
  fs.realpathSync = stub;
  try {
    fn();
  } finally {
    fs.realpathSync = original;
  }
  return counts;
}

function tree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-single-'));
  fs.mkdirSync(path.join(dir, 'real'));
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('off win32 one candidate costs one realpath walk, not two', { skip: process.platform === 'win32' }, (t) => {
  const dir = tree(t);
  const target = path.join(dir, 'link', 'new.txt');
  let targets;
  const counts = countRealpaths(() => { targets = files.targetsOf(target, { platform: 'linux' }); });
  assert.deepStrictEqual(targets, [path.join(dir, 'real', 'new.txt')]);
  assert.strictEqual(counts.plain, 1);
  assert.strictEqual(counts.native, 0);
});

test('on win32 targetsOf keeps both targets and the native walk', (t) => {
  const dir = tree(t);
  const target = path.join(dir, 'link', 'new.txt');
  let targets;
  const counts = countRealpaths(() => { targets = files.targetsOf(target, { platform: 'win32', realpath: fs.realpathSync.native }); });
  assert.strictEqual(targets.length, 2);
  assert.strictEqual(targets[0], files.realTargetOf(target));
  assert.strictEqual(targets[1], files.nativeTargetOf(target, { platform: 'win32' }));
  assert.strictEqual(counts.native, 1);
});

test('off win32 a bash denial check never runs the native realpath', { skip: process.platform === 'win32' }, (t) => {
  const dir = tree(t);
  const counts = countRealpaths(() => {
    policy.bashDenial('cat ' + path.join(dir, 'link', 'missing', 'file.txt'), { cwd: dir, home: os.homedir(), env: {} });
  });
  assert.ok(counts.plain > 0, 'the check does resolve paths');
  assert.strictEqual(counts.native, 0);
});
