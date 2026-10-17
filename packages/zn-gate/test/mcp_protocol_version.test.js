'use strict';

// zn's MCP servers answer initialize with the protocol version they speak (2024-11-05), whatever version a newer
// client asks for: the client then uses that version or disconnects. Checked against the real servers.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function initialize(args, version) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ZN_STATS: 'off' } });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('no answer to initialize')); }, 15000);
    child.stdout.on('data', (d) => {
      buf += d;
      const line = buf.split('\n').find((l) => l.includes('"id":1'));
      if (!line) return;
      clearTimeout(timer);
      child.kill();
      resolve(JSON.parse(line));
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'zn-test', version: '0' } } }) + '\n');
  });
}

for (const [name, args] of [['zn mcp', ['mcp']], ['secrets', ['secrets-mcp']]]) {
  test(name + ' answers initialize with 2024-11-05 for newer and older clients', async () => {
    for (const asked of ['2026-07-28', '2025-11-25', '2024-11-05']) {
      const r = await initialize(args, asked);
      assert.equal(r.result.protocolVersion, '2024-11-05', asked);
      assert.ok(r.result.capabilities.tools, asked);
    }
  });
}
