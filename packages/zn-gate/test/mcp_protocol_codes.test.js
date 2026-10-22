'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const proto = require('../lib/mcp-protocol');

test('allowsBatching is true only for 2025-03-26', () => {
  assert.equal(proto.allowsBatching('2025-03-26'), true);
  for (const v of ['2024-11-05', '2025-06-18', '2025-11-25', undefined]) {
    assert.equal(proto.allowsBatching(v), false, String(v));
  }
});

test('unknownToolCode uses -32602 from 2025-06-18 and -32601 otherwise', () => {
  assert.equal(proto.unknownToolCode('2025-06-18'), -32602);
  assert.equal(proto.unknownToolCode('2025-11-25'), -32602);
  assert.equal(proto.unknownToolCode('2024-11-05'), -32601);
  assert.equal(proto.unknownToolCode('2025-03-26'), -32601);
  assert.equal(proto.unknownToolCode(undefined), -32601);
});

test('BATCH_REJECTED is an invalid request error that names 2025-06-18', () => {
  assert.equal(proto.BATCH_REJECTED.code, -32600);
  assert.match(proto.BATCH_REJECTED.message, /2025-06-18/);
});
