'use strict';

// Secrets MCP server (lib/broker/mcp.js): batch replies per message and a single initialize per session.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSecretsServer } = require('../lib/broker/mcp');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');

const newServer = () => createSecretsServer({ vault: createFakeVault(), engine: fakeEngine });
const init = (srv, v) => srv.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v } });

function throwing(id) {
  return { jsonrpc: '2.0', id, method: 'tools/call', get params() { throw new Error('boom'); } };
}

test('batch: a throwing message errors only itself; notifications get no entry', async () => {
  const srv = newServer();
  await init(srv, '2025-03-26');
  const res = await srv.handleBatch([
    { jsonrpc: '2.0', id: 10, method: 'ping' },
    throwing(11),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    throwing(undefined),
    { jsonrpc: '2.0', id: 12, method: 'ping' },
  ]);
  assert.equal(res.length, 3);
  assert.deepEqual(res[0].result, {});
  assert.equal(res[1].id, 11);
  assert.equal(res[1].error.code, -32603);
  assert.equal(res[2].id, 12);
  assert.deepEqual(res[2].result, {});
});

test('a second initialize is rejected and the version stays', async () => {
  const srv = newServer();
  const first = await init(srv, '2025-03-26');
  assert.equal(first.result.protocolVersion, '2025-03-26');
  const again = await init(srv, '2024-11-05');
  assert.equal(again.error.code, -32600);
  assert.equal(again.result, undefined);
  const list = await srv.handleBatch([{ jsonrpc: '2.0', id: 2, method: 'ping' }]);
  assert.ok(Array.isArray(list), 'batching still allowed: version unchanged');
});

test('batch: initialize inside the batch is rejected after the session started', async () => {
  const srv = newServer();
  await init(srv, '2025-03-26');
  const res = await srv.handleBatch([
    { jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 6, method: 'ping' },
  ]);
  assert.equal(res[0].id, 5);
  assert.equal(res[0].error.code, -32600);
  assert.deepEqual(res[1].result, {});
  const still = await srv.handleBatch([{ jsonrpc: '2.0', id: 7, method: 'ping' }]);
  assert.ok(Array.isArray(still), 'version still 2025-03-26');
});
