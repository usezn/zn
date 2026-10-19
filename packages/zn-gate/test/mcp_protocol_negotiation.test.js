'use strict';

// zn's two MCP servers (`zn-gate mcp`, `zn-gate secrets-mcp`) negotiate the protocol version in initialize:
// the client's if zn speaks it, else the latest. Each negotiated version gets a valid tools/list and a
// tools/call round trip. Checked against the real servers over stdio.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const proto = require('../lib/mcp-protocol');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const SERVERS = [
  ['zn mcp', ['mcp'], { name: 'zn_status', args: {} }],
  ['secrets', ['secrets-mcp'], { name: 'secrets_list', args: {} }],
];

// Sends the lines, waits for `want` JSON lines on stdout and returns them parsed.
function session(args, lines, want) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ZN_STATS: 'off', ZN_LOCAL_ONLY: 'true' };
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'ignore'], env });
    const out = [];
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('no answer: got ' + out.length + ' of ' + want)); }, 20000);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (l) out.push(JSON.parse(l));
      }
      if (out.length >= want) { clearTimeout(timer); child.kill(); resolve(out); }
    });
    child.on('error', reject);
    child.stdin.on('error', () => {});
    for (const l of lines) child.stdin.write((typeof l === 'string' ? l : JSON.stringify(l)) + '\n');
  });
}
const init = (version) => ({ jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'zn-test', version: '0' } } });

test('the shared helper lists the versions and negotiates', () => {
  assert.deepEqual(proto.SUPPORTED_PROTOCOL_VERSIONS, ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
  assert.equal(proto.negotiateProtocolVersion({ protocolVersion: '2025-06-18' }), '2025-06-18');
  assert.equal(proto.negotiateProtocolVersion({ protocolVersion: '2099-01-01' }), '2025-11-25');
  assert.equal(proto.negotiateProtocolVersion({ protocolVersion: 5 }), '2025-11-25');
  assert.equal(proto.negotiateProtocolVersion(undefined), '2025-11-25');
});

for (const [name, args, call] of SERVERS) {
  for (const version of proto.SUPPORTED_PROTOCOL_VERSIONS) {
    test(`${name}: ${version} negotiates, lists tools and answers a call`, async () => {
      const [i, l, c] = await session(args, [
        init(version),
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: call.name, arguments: call.args } },
      ], 3);
      assert.equal(i.result.protocolVersion, version);
      assert.ok(i.result.capabilities.tools);
      const tools = l.result.tools;
      assert.ok(tools.length > 0);
      for (const t of tools) {
        assert.equal(typeof t.name, 'string');
        assert.equal(t.inputSchema.type, 'object');
        assert.equal('annotations' in t, version >= '2025-03-26', `annotations on ${t.name}`);
        assert.equal('title' in t, version >= '2025-06-18', `title on ${t.name}`);
        if (version >= '2025-06-18') assert.equal(t.title, t.annotations.title);
      }
      assert.equal(c.id, 3);
      assert.ok(Array.isArray(c.result.content) && c.result.content[0].type === 'text');
    });
  }

  test(`${name}: an unknown or malformed version gets the latest`, async () => {
    for (const asked of ['2026-07-28', '2023-01-01', 'latest', 20250618, null]) {
      const [r] = await session(args, [init(asked)], 1);
      assert.equal(r.result.protocolVersion, proto.LATEST_PROTOCOL_VERSION, String(asked));
    }
  });

  test(`${name}: batches work up to 2025-03-26 and are rejected from 2025-06-18`, async () => {
    const batch = [{ jsonrpc: '2.0', id: 10, method: 'ping' }, { jsonrpc: '2.0', id: 11, method: 'tools/list' }];
    for (const version of ['2024-11-05', '2025-03-26']) {
      const [, b] = await session(args, [init(version), batch], 2);
      assert.ok(Array.isArray(b) && b.length === 2, version);
      assert.deepEqual(b.map((r) => r.id).sort(), [10, 11]);
    }
    for (const version of ['2025-06-18', '2025-11-25']) {
      const [, b] = await session(args, [init(version), batch], 2);
      assert.equal(b.error.code, -32600, version);
      assert.equal(b.id, null);
    }
  });
}
