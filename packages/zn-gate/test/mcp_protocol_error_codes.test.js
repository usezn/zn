'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const proto = require('../lib/mcp-protocol');

const VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', undefined];

// Every error code the module can hand out: the fixed batch error and the per-version unknown tool codes.
function exportedCodes() {
  const codes = { batchRejected: proto.BATCH_REJECTED.code };
  for (const v of VERSIONS) codes[`unknownTool(${v})`] = proto.unknownToolCode(v);
  return codes;
}

test('every exported JSON-RPC error code is an integer', () => {
  for (const [name, code] of Object.entries(exportedCodes())) {
    assert.ok(Number.isInteger(code), `${name} is ${code}`);
  }
});

test('error codes are in the JSON-RPC reserved range', () => {
  for (const [name, code] of Object.entries(exportedCodes())) {
    assert.ok(code >= -32768 && code <= -32000, `${name} is ${code}`);
  }
});

test('the batch error code differs from the unknown tool codes', () => {
  const unknown = new Set(VERSIONS.map((v) => proto.unknownToolCode(v)));
  assert.equal(unknown.size, 2);
  assert.equal(unknown.has(proto.BATCH_REJECTED.code), false);
});

test('BATCH_REJECTED carries an integer code and a message', () => {
  assert.equal(typeof proto.BATCH_REJECTED.message, 'string');
  assert.ok(Number.isInteger(proto.BATCH_REJECTED.code));
});
