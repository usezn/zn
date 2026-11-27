'use strict';

// The test folder of zn-gate check can stay locked on Windows for a moment after its hooks stop. Removing it must
// not fail the check there; any other failure, and any failure on another system, still surfaces.

const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../lib/check');

function withPlatform(value, fn) {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', saved);
  }
}

function failing(t, code) {
  const calls = [];
  t.mock.method(require('fs'), 'rmSync', (dir, opts) => {
    calls.push(opts);
    throw Object.assign(new Error(code + ': resource busy or locked'), { code });
  });
  return calls;
}

test('check: on Windows a busy test folder is left behind after bounded retries instead of failing the check', (t) => {
  for (const code of ['EBUSY', 'EPERM', 'ENOTEMPTY']) {
    const calls = failing(t, code);
    withPlatform('win32', () => _internal.removeTestFolder('zn-check-example'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].maxRetries, 10);
    assert.ok(calls[0].retryDelay > 0);
    t.mock.restoreAll();
  }
});

test('check: other removal errors, and a busy folder on other systems, are still thrown', (t) => {
  failing(t, 'EACCES');
  assert.throws(() => withPlatform('win32', () => _internal.removeTestFolder('zn-check-example')), { code: 'EACCES' });
  t.mock.restoreAll();
  failing(t, 'EBUSY');
  assert.throws(() => withPlatform('linux', () => _internal.removeTestFolder('zn-check-example')), { code: 'EBUSY' });
});
