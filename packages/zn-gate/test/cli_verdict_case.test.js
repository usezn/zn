'use strict';
// The CLI treats a verdict as a block whatever its case, like the MCP server does.
// A local HTTP server stands in for the gate; nothing leaves the machine.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const KEY = 'zn_test_' + 'a1b2c3d4e5f6a7b8c9d0e1f2';

function run(verdict) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ verdict, confidence: 0.99, billed_calls: 1, input_chars: 11 }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const env = { ...process.env, ZN_CLOUD: '1', ZN_API_KEY: KEY, ZN_API_URL: 'http://127.0.0.1:' + server.address().port + '/v30/analyze' };
      delete env.ZN_LOCAL_ONLY;
      const child = spawn(process.execPath, [CLI, 'analyze', 'hello there'], { env });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', reject);
      child.on('close', (code) => { server.close(); resolve({ code, out }); });
    });
  });
}

for (const [verdict, code] of [['block', 2], ['BLOCK', 2], ['Block', 2], ['allow', 0], ['ALLOW', 0]]) {
  test('analyze exits ' + code + ' for the verdict ' + verdict, async () => {
    const r = await run(verdict);
    assert.strictEqual(r.code, code, r.out);
  });
}
