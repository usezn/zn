'use strict';

// lib/mcp.js handleBatch over fake stdin/stdout streams: empty batch, notifications only, known and
// unknown methods, before and after protocol negotiation, and reply order. Fake values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const ZN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-gatebatch-'));
const SAVED = { ZN_HOME: process.env.ZN_HOME, ZN_CLOUD: process.env.ZN_CLOUD, ZN_API_KEY: process.env.ZN_API_KEY };
process.env.ZN_HOME = ZN_HOME;
delete process.env.ZN_CLOUD;
delete process.env.ZN_API_KEY;
test.after(() => {
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(ZN_HOME, { recursive: true, force: true });
});

const MODULE = require.resolve('../lib/mcp');

// The negotiated version is module state, so each session loads a fresh copy of the module.
async function session(lines, options = { localOnly: true }) {
  delete require.cache[MODULE];
  const gate = require('../lib/mcp');
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => { text += d; });
  const desc = {
    stdin: Object.getOwnPropertyDescriptor(process, 'stdin'),
    stdout: Object.getOwnPropertyDescriptor(process, 'stdout'),
  };
  const realExit = process.exit;
  let closed;
  const done = new Promise((resolve) => { closed = resolve; });
  process.exit = (code) => closed(code);
  Object.defineProperty(process, 'stdin', { value: input, configurable: true });
  Object.defineProperty(process, 'stdout', { value: output, configurable: true });
  try {
    gate.startMcpServer(options);
    for (const l of lines) input.write((typeof l === 'string' ? l : JSON.stringify(l)) + '\n');
    input.end();
    assert.equal(await done, 0);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.exit = realExit;
    Object.defineProperty(process, 'stdin', desc.stdin);
    Object.defineProperty(process, 'stdout', desc.stdout);
  }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
const note = (method) => ({ jsonrpc: '2.0', method });
const init = (version) => rpc(1, 'initialize', { protocolVersion: version });

test('an empty batch is rejected even when batching is allowed', async () => {
  const [, r] = await session([init('2025-03-26'), []]);
  assert.equal(r.id, null);
  assert.equal(r.error.code, -32600);
  assert.match(r.error.message, /batches are not supported/);
});

test('a batch of notifications only produces no output at all', async () => {
  const replies = await session([
    init('2025-03-26'),
    [note('notifications/initialized'), note('notifications/cancelled'), note('no/such/notification')],
  ]);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 1);
});

test('known and unknown methods in one batch: one reply each, notifications stay silent', async () => {
  const replies = await session([
    init('2025-03-26'),
    [
      rpc(10, 'ping'),
      rpc(11, 'no/such/method'),
      note('no/such/notification'),
      rpc(12, 'tools/call', { name: 'no_such_tool', arguments: {} }),
      rpc(13, 'tools/call', {}),
      rpc(14, 'tools/list'),
    ],
  ]);
  const batch = replies[1];
  assert.ok(Array.isArray(batch));
  assert.deepEqual(batch.map((r) => r.id), [10, 11, 12, 13, 14]);
  assert.deepEqual(batch[0].result, {});
  assert.equal(batch[1].error.code, -32601);
  assert.match(batch[1].error.message, /no\/such\/method/);
  assert.equal(batch[2].error.code, -32601);
  assert.equal(batch[3].error.code, -32602);
  assert.equal(batch[4].result.tools.length, 4);
});

test('replies keep request order when an earlier request is slower', async () => {
  const replies = await session([
    init('2025-03-26'),
    [
      rpc(20, 'tools/call', { name: 'analyze_prompt', arguments: { text: 'Please list the files in this folder.' } }),
      rpc(21, 'ping'),
      rpc(22, 'tools/call', { name: 'zn_status', arguments: {} }),
      rpc(23, 'ping'),
    ],
  ]);
  assert.deepEqual(replies[1].map((r) => r.id), [20, 21, 22, 23]);
  assert.ok(replies[1][0].result.content[0].text.length > 0);
});

test('a batch is written as one array line, separate from a single reply', async () => {
  const replies = await session([init('2025-03-26'), [rpc(30, 'ping'), rpc(31, 'ping')], rpc(32, 'ping')]);
  assert.equal(replies.length, 3);
  const arrays = replies.filter(Array.isArray);
  assert.equal(arrays.length, 1);
  assert.deepEqual(arrays[0].map((r) => r.id), [30, 31]);
  assert.ok(replies.some((r) => !Array.isArray(r) && r.id === 32));
});

test('a batch before initialize is rejected as one error, with no replies for its entries', async () => {
  const replies = await session([[rpc(40, 'ping'), rpc(41, 'ping')]]);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, null);
  assert.equal(replies[0].error.code, -32600);
});

test('a batch after a version without batching is rejected, and works after a later 2025-03-26 initialize', async () => {
  const replies = await session([
    init('2025-06-18'),
    [rpc(50, 'ping')],
    init('2025-03-26'),
    [rpc(51, 'ping')],
  ]);
  assert.equal(replies[1].error.code, -32600);
  assert.equal(replies[2].result.protocolVersion, '2025-03-26');
  assert.deepEqual(replies[3].map((r) => r.id), [51]);
});

test('non-object entries in a batch are answered one by one without breaking the others', async () => {
  const replies = await session([init('2025-03-26'), [null, rpc(60, 'ping')]]);
  assert.ok(Array.isArray(replies[1]));
  assert.deepEqual(replies[1].map((r) => r.id), [60]);
});
