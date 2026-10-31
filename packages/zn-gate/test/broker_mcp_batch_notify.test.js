'use strict';

// handleBatch and notify of the secrets MCP server (lib/broker/mcp.js): JSON-RPC batches with
// requests and notifications, batch rules per protocol version, and the notice a request prints.
// Fake vault and fictitious names only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createSecretsServer } = require('../lib/broker/mcp');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const BATCH_REJECTED = { code: -32600, message: 'Invalid Request: JSON-RPC batches are not supported from MCP 2025-06-18' };

async function initialized(version, opts = {}) {
  const srv = createSecretsServer({ vault: createFakeVault(), engine: fakeEngine, ...opts });
  const r = await srv.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: version } });
  assert.equal(r.result.protocolVersion, version);
  return srv;
}

test('handleBatch 2025-03-26: replies come back by id, notifications and their results get no reply', async () => {
  const srv = await initialized('2025-03-26');
  const replies = await srv.handleBatch([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'two', method: 'tools/list' },
    { jsonrpc: '2.0', method: 'whatever/else' },
    { jsonrpc: '2.0', id: 3, method: 'resources/list' },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: ['not-a-string'] } },
    null,
  ]);
  assert.ok(Array.isArray(replies));
  assert.deepEqual(replies.map((r) => r.id), [1, 'two', 3, 4], 'one reply per request, in order, none for notifications');
  const byId = Object.fromEntries(replies.map((r) => [String(r.id), r]));
  assert.deepEqual(byId['1'], { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(byId.two.jsonrpc, '2.0');
  assert.ok(Array.isArray(byId.two.result.tools) && byId.two.result.tools.length > 0);
  assert.deepEqual(byId['3'].error, { code: -32601, message: 'Unsupported method: resources/list' });
  assert.equal(byId['4'].error.code, -32602);
  for (const r of replies) assert.equal(r.jsonrpc, '2.0');
});

test('handleBatch 2025-03-26: a batch of only notifications gives null, so nothing is written', async () => {
  const srv = await initialized('2025-03-26');
  const r = await srv.handleBatch([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', method: 'unknown/notice' },
  ]);
  assert.equal(r, null);
});

test('handleBatch 2025-03-26: an empty batch is an Invalid Request error with id null', async () => {
  const srv = await initialized('2025-03-26');
  const r = await srv.handleBatch([]);
  assert.deepEqual(r, { jsonrpc: '2.0', id: null, error: BATCH_REJECTED });
});

test('handleBatch 2025-06-18 and later: batches are refused as one error and no message in them runs', async () => {
  for (const version of ['2025-06-18', '2025-11-25']) {
    const srv = await initialized(version);
    const r = await srv.handleBatch([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    assert.ok(!Array.isArray(r), 'a single object, not an array of replies');
    assert.deepEqual(r, { jsonrpc: '2.0', id: null, error: BATCH_REJECTED });
    assert.equal(r.error.code, -32600);
  }
});

test('handleBatch 2024-11-05 and before initialize: batches are refused too', async () => {
  const old = await initialized('2024-11-05');
  assert.deepEqual(await old.handleBatch([{ jsonrpc: '2.0', id: 1, method: 'ping' }]), { jsonrpc: '2.0', id: null, error: BATCH_REJECTED });
  const fresh = createSecretsServer({ vault: createFakeVault(), engine: fakeEngine });
  assert.deepEqual(await fresh.handleBatch([{ jsonrpc: '2.0', id: 1, method: 'ping' }]), { jsonrpc: '2.0', id: null, error: BATCH_REJECTED });
  assert.deepEqual(await fresh.handleBatch([]), { jsonrpc: '2.0', id: null, error: BATCH_REJECTED });
});

test('handleBatch: a request that fails inside the batch does not stop the others', async () => {
  const srv = await initialized('2025-03-26');
  const replies = await srv.handleBatch([
    { jsonrpc: '2.0', id: 'bad', method: 'tools/call', params: { name: 'secrets_request', arguments: { value: 'x' } } },
    { jsonrpc: '2.0', id: 'good', method: 'ping' },
  ]);
  assert.deepEqual(replies.map((r) => r.id), ['bad', 'good']);
  const bad = JSON.parse(replies[0].result.content[0].text);
  assert.equal(replies[0].result.isError, true);
  assert.match(bad.message, /never takes a value/);
  assert.deepEqual(replies[1].result, {});
});

test('notify: a secrets_request calls notify once with the agent, name, reason and the command to run', async (t) => {
  const home = tempDir(t, 'zn-b2190-home-');
  const lines = [];
  const srv = createSecretsServer({ vault: createFakeVault(), engine: fakeEngine, home, agent: 'claude-code', notify: (l) => lines.push(l) });
  const r = await srv.callTool('secrets_request', { name: 'DEMO_API_KEY', reason: 'call the demo service' });
  assert.notEqual(r.isError, true);
  assert.deepEqual(lines, ['zn: claude-code asks for secret DEMO_API_KEY (call the demo service). Add it with: zn secret set DEMO_API_KEY']);
  const rec = fs.readFileSync(path.join(home, '.zn', 'requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rec.length, 1);
  assert.equal(rec[0].name, 'DEMO_API_KEY');
});

test('notify: without a reason the message has no empty parentheses', async (t) => {
  const home = tempDir(t, 'zn-b2190-home-');
  const lines = [];
  const srv = createSecretsServer({ vault: createFakeVault(), engine: fakeEngine, home, agent: 'codex', notify: (l) => lines.push(l) });
  await srv.callTool('secrets_request', { name: 'DEMO_API_KEY' });
  assert.deepEqual(lines, ['zn: codex asks for secret DEMO_API_KEY. Add it with: zn secret set DEMO_API_KEY']);
});

test('notify: control characters in the reason become spaces and a long reason is cut to 300 characters', async (t) => {
  const home = tempDir(t, 'zn-b2190-home-');
  const lines = [];
  const srv = createSecretsServer({ vault: createFakeVault(), engine: fakeEngine, home, agent: 'codex', notify: (l) => lines.push(l) });
  await srv.callTool('secrets_request', { name: 'DEMO_API_KEY', reason: 'one\ntwo\u001b[2Jthree' + 'x'.repeat(400) });
  assert.equal(lines.length, 1);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(lines[0].replace(/\n$/, '')), 'no control characters on the line');
  const reason = /\((.*)\)\. Add it/.exec(lines[0])[1];
  assert.equal(reason.length, 300);
  assert.match(reason, /^one two\s?\[2Jthree/);
});

test('notify: a refused request (invalid name or a value) never calls notify', async (t) => {
  const home = tempDir(t, 'zn-b2190-home-');
  const lines = [];
  const srv = createSecretsServer({ vault: createFakeVault(), engine: fakeEngine, home, agent: 'codex', notify: (l) => lines.push(l) });
  const bad = await srv.callTool('secrets_request', { name: 'lower-case' });
  assert.equal(bad.isError, true);
  const withValue = await srv.callTool('secrets_request', { name: 'DEMO_API_KEY', value: 'x' });
  assert.equal(withValue.isError, true);
  assert.deepEqual(lines, []);
});

test('notify: without an injected notify the line goes to stderr with a newline', async (t) => {
  const home = tempDir(t, 'zn-b2190-home-');
  const srv = createSecretsServer({ vault: createFakeVault(), engine: fakeEngine, home, agent: 'codex' });
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return true; };
  try {
    await srv.callTool('secrets_request', { name: 'DEMO_API_KEY', reason: 'r' });
  } finally {
    process.stderr.write = original;
  }
  assert.deepEqual(written, ['zn: codex asks for secret DEMO_API_KEY (r). Add it with: zn secret set DEMO_API_KEY\n']);
});
