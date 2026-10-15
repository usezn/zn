'use strict';

// MCP tool annotations: every zn tool says what it does to the user's environment (title, readOnlyHint,
// destructiveHint, idempotentHint, openWorldHint), with honest values, and tools/list serves them.

const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../lib/mcp');
const broker = require('../lib/broker/mcp');

const FIELDS = ['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
const EXPECTED = {
  analyze_prompt: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  check_tool_call: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  check_tool_result: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  zn_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  secrets_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  secrets_http_request: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  secrets_render_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  secrets_request: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

test('every zn MCP tool has all five annotations with the documented values', () => {
  const tools = [...gate.TOOLS, ...broker.TOOLS];
  assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(EXPECTED).sort());
  for (const t of tools) {
    assert.ok(t.annotations, t.name);
    for (const f of FIELDS) assert.ok(f in t.annotations, t.name + ' ' + f);
    assert.equal(typeof t.annotations.title, 'string');
    assert.ok(t.annotations.title.length > 0 && t.annotations.title.length <= 60, t.name);
    const { title, ...hints } = t.annotations;
    assert.deepEqual(hints, EXPECTED[t.name], t.name);
    // A read-only tool can be neither destructive nor reach the outside world here.
    if (hints.readOnlyHint) assert.equal(hints.destructiveHint, false, t.name);
  }
});

test('analyze_prompt reaches the outside world only with the optional cloud check on', () => {
  const off = gate.toolsFor({ localOnly: true }).find((t) => t.name === 'analyze_prompt');
  assert.equal(off.annotations.openWorldHint, false);
  const saved = { ...process.env };
  try {
    process.env.ZN_CLOUD = '1';
    process.env.ZN_API_KEY = 'zn_live_' + 'a'.repeat(32);
    delete process.env.ZN_LOCAL_ONLY;
    const on = gate.toolsFor({}).find((t) => t.name === 'analyze_prompt');
    assert.equal(on.annotations.openWorldHint, true);
    assert.equal(gate.TOOLS.find((t) => t.name === 'analyze_prompt').annotations.openWorldHint, false, 'the shared list is not changed');
  } finally {
    for (const k of ['ZN_CLOUD', 'ZN_API_KEY', 'ZN_LOCAL_ONLY']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

test('the secrets server lists its tools with annotations', async () => {
  const server = broker.createSecretsServer({ home: require('os').tmpdir(), agent: 'test', vault: {} });
  const r = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(r.result.tools.length, 4);
  assert.ok(r.result.tools.every((t) => t.annotations && typeof t.annotations.readOnlyHint === 'boolean'));
});
