'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isBrokenPipe } = require('../lib/broken-pipe');

test('isBrokenPipe: EPIPE is a broken pipe on Linux and on Windows', () => {
  assert.equal(isBrokenPipe({ code: 'EPIPE' }, 'linux'), true);
  assert.equal(isBrokenPipe({ code: 'EPIPE' }, 'win32'), true);
});

test('isBrokenPipe: EOF is a broken pipe on Windows only', () => {
  assert.equal(isBrokenPipe({ code: 'EOF' }, 'win32'), true);
  assert.equal(isBrokenPipe({ code: 'EOF' }, 'linux'), false);
});

test('isBrokenPipe: other errors and missing errors are not a broken pipe', () => {
  assert.equal(isBrokenPipe({ code: 'ENOSPC' }, 'win32'), false);
  assert.equal(isBrokenPipe({ code: 'ENOSPC' }, 'linux'), false);
  assert.equal(isBrokenPipe(null, 'win32'), false);
  assert.equal(isBrokenPipe(undefined, 'linux'), false);
});
