'use strict';

// handleRequest of the zn-gate MCP server called in process: initialize with a known, a newer, an older
// and no protocol version, plus ping and an unknown method (result shape, echoed id, error code).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ZN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-handlebasic-'));
const SAVED_ZN_HOME = process.env.ZN_HOME;
process.env.ZN_HOME = ZN_HOME;
test.after(() => {
  if (SAVED_ZN_HOME === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = SAVED_ZN_HOME;
  fs.rmSync(ZN_HOME, { recursive: true, force: true });
});

const gate = require('../lib/mcp');
const proto = require('../lib/mcp-protocol');

async function ask(message) {
  const replies = [];
  const real = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk === 'string' && chunk.startsWith('{"jsonrpc":"2.0"')) { replies.push(JSON.parse(chunk)); return true; }
    return real.call(process.stdout, chunk, ...rest);
  };
  try {
    await gate.handleRequest(message, { localOnly: true });
  } finally {
    process.stdout.write = real;
  }
  return replies;
}

const LATEST = proto.SUPPORTED_PROTOCOL_VERSIONS[0];
const OLDEST = proto.SUPPORTED_PROTOCOL_VERSIONS[proto.SUPPORTED_PROTOCOL_VERSIONS.length - 1];
const init = (id, params) => ({ id, method: 'initialize', params });

test('initialize replies with the result shape and echoes the id', async () => {
  const replies = await ask(init(7, { protocolVersion: LATEST }));
  assert.equal(replies.length, 1);
  const [r] = replies;
  assert.equal(r.jsonrpc, '2.0');
  assert.equal(r.id, 7);
  assert.equal(r.error, undefined);
  assert.deepEqual(Object.keys(r.result).sort(), ['capabilities', 'protocolVersion', 'serverInfo']);
  assert.deepEqual(r.result.capabilities, { tools: {} });
  assert.deepEqual(r.result.serverInfo, { name: gate.SERVER_NAME, version: gate.SERVER_VERSION });
});

test('initialize echoes a string id too', async () => {
  const [r] = await ask(init('req-1', { protocolVersion: LATEST }));
  assert.equal(r.id, 'req-1');
});

test('initialize with a version the server knows answers with that version', async () => {
  for (const v of proto.SUPPORTED_PROTOCOL_VERSIONS) {
    const [r] = await ask(init(1, { protocolVersion: v }));
    assert.equal(r.result.protocolVersion, v);
  }
});

test('initialize with a newer version answers with the latest known one', async () => {
  const [r] = await ask(init(2, { protocolVersion: '2099-01-01' }));
  assert.equal(r.result.protocolVersion, LATEST);
});

test('initialize with an older, unknown version answers with the latest known one', async () => {
  const [r] = await ask(init(3, { protocolVersion: '2020-01-01' }));
  assert.ok('2020-01-01' < OLDEST);
  assert.equal(r.result.protocolVersion, LATEST);
});

test('initialize without a version, or without params, answers with the latest known one', async () => {
  const [a] = await ask(init(4, {}));
  assert.equal(a.result.protocolVersion, LATEST);
  const [b] = await ask({ id: 5, method: 'initialize' });
  assert.equal(b.id, 5);
  assert.equal(b.result.protocolVersion, LATEST);
});

test('ping answers with an empty result and the same id', async () => {
  const [r] = await ask({ id: 11, method: 'ping' });
  assert.deepEqual(r, { jsonrpc: '2.0', id: 11, result: {} });
  const [s] = await ask({ id: 'p', method: 'ping' });
  assert.deepEqual(s, { jsonrpc: '2.0', id: 'p', result: {} });
});

test('an unknown method gets -32601 with the same id and no result', async () => {
  const replies = await ask({ id: 21, method: 'does/not/exist' });
  assert.equal(replies.length, 1);
  const [r] = replies;
  assert.equal(r.jsonrpc, '2.0');
  assert.equal(r.id, 21);
  assert.equal(r.result, undefined);
  assert.equal(r.error.code, -32601);
  assert.equal(typeof r.error.message, 'string');
});
