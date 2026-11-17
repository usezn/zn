'use strict';

// lib/mcp.js stdin framing: one message is capped, a longer line is dropped as it streams past with one
// Invalid Request error, and the next message is still served. Fake values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const ZN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-gatelinecap-'));
const SAVED = {
  ZN_HOME: process.env.ZN_HOME,
  ZN_CLOUD: process.env.ZN_CLOUD,
  ZN_API_KEY: process.env.ZN_API_KEY,
  ZN_MCP_MAX_LINE_BYTES: process.env.ZN_MCP_MAX_LINE_BYTES,
};
process.env.ZN_HOME = ZN_HOME;
delete process.env.ZN_CLOUD;
delete process.env.ZN_API_KEY;
test.after(() => {
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(ZN_HOME, { recursive: true, force: true });
});

const MODULE = require.resolve('../lib/mcp');
const CAP = 4096;

// Runs the server over fake streams; feed(input) writes whatever the test wants, then the input is ended.
async function session(feed, cap = CAP) {
  if (cap === undefined) delete process.env.ZN_MCP_MAX_LINE_BYTES; else process.env.ZN_MCP_MAX_LINE_BYTES = String(cap);
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
    gate.startMcpServer({ localOnly: true });
    await feed(input);
    input.end();
    assert.equal(await done, 0);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.exit = realExit;
    Object.defineProperty(process, 'stdin', desc.stdin);
    Object.defineProperty(process, 'stdout', desc.stdout);
    delete process.env.ZN_MCP_MAX_LINE_BYTES;
  }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const ping = (id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' });
// A valid message of exactly `bytes` bytes (a padding member in params).
function padded(id, bytes) {
  const base = JSON.stringify({ jsonrpc: '2.0', id, method: 'ping', params: { pad: '' } });
  assert.ok(bytes >= base.length);
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'ping', params: { pad: 'a'.repeat(bytes - base.length) } });
}

test('a message exactly at the cap is processed', async () => {
  const msg = padded(1, CAP);
  assert.equal(Buffer.byteLength(msg), CAP);
  const out = await session((i) => i.write(msg + '\n'));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
  assert.equal(out[0].error, undefined);
});

test('a message one byte over the cap gets one Invalid Request error and the next message is served', async () => {
  const msg = padded(1, CAP + 1);
  const out = await session((i) => i.write(msg + '\n' + ping(2) + '\n'));
  assert.equal(out.length, 2);
  assert.equal(out[0].id, null);
  assert.equal(out[0].error.code, -32600);
  assert.match(out[0].error.message, /^Invalid Request: the message is larger than 4096 bytes$/);
  assert.equal(out[1].id, 2);
  assert.equal(out[1].error, undefined);
});

test('the error does not echo any of the dropped line', async () => {
  const out = await session((i) => i.write('{"secret":"' + 'z'.repeat(CAP * 2) + '"}\n'));
  assert.equal(out.length, 1);
  assert.ok(!JSON.stringify(out).includes('zzz'));
});

test('a line that never ends keeps the buffer bounded and is answered once', async () => {
  const chunk = Buffer.alloc(1000, 0x61);
  let fed = 0;
  const out = await session(async (i) => {
    // Far more than the cap, in chunks, with no newline; then the line ends and a valid message follows.
    while (fed < CAP * 50) {
      i.write(chunk);
      fed += chunk.length;
      // The stream's own buffer is what this process holds: it must not grow with what was fed.
      assert.ok(i.readableLength <= CAP + chunk.length, `readable buffer ${i.readableLength}`);
      await new Promise((r) => setImmediate(r));
    }
    i.write('\n' + ping(9) + '\n');
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].error.code, -32600);
  assert.equal(out[1].id, 9);
});

test('the line reader holds at most the cap while a line streams past', () => {
  const { createLineReader } = require('../lib/shield_framing');
  const s = new PassThrough();
  let oversize = null;
  let lines = 0;
  createLineReader(s, { maxBytes: CAP, onLine: () => { lines++; }, onOversize: (info) => { oversize = info; } });
  const chunk = Buffer.alloc(1000, 0x61);
  for (let n = 0; n < CAP * 20; n += chunk.length) s.write(chunk);
  s.write('\nok\n');
  s.end();
  return new Promise((r) => setImmediate(r)).then(() => {
    assert.equal(oversize.bytes, Math.ceil((CAP * 20) / 1000) * 1000);
    assert.ok(oversize.head.length <= 4096);
    assert.equal(lines, 1);
  });
});

test('CRLF line endings are handled as before', async () => {
  const out = await session((i) => i.write(ping(1) + '\r\n' + ping(2) + '\r\n'));
  assert.deepEqual(out.map((m) => m.id), [1, 2]);
});

test('blank lines are ignored', async () => {
  const out = await session((i) => i.write('\n\r\n   \n' + ping(3) + '\n'));
  assert.deepEqual(out.map((m) => m.id), [3]);
});

test('a line split across chunks (and inside a multi-byte character) reassembles', async () => {
  const text = ping(5).replace('"ping"', '"ping","params":{"note":"café 中文"}');
  const bytes = Buffer.from(text + '\n');
  const out = await session(async (i) => {
    for (let n = 0; n < bytes.length; n += 3) {
      i.write(bytes.subarray(n, n + 3));
      await new Promise((r) => setImmediate(r));
    }
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 5);
  assert.equal(out[0].error, undefined);
});

test('a last line with no newline is still processed at end of input', async () => {
  const out = await session((i) => i.write(ping(4)));
  assert.deepEqual(out.map((m) => m.id), [4]);
});

test('malformed JSON under the cap still gets a parse error', async () => {
  const out = await session((i) => i.write('{nope\n'));
  assert.equal(out[0].error.code, -32700);
});

test('ZN_MCP_MAX_LINE_BYTES can only lower the cap', () => {
  delete require.cache[MODULE];
  const gate = require('../lib/mcp');
  const def = gate.MAX_LINE_BYTES;
  assert.equal(gate.resolveLineCap({}), def);
  assert.equal(gate.resolveLineCap({ ZN_MCP_MAX_LINE_BYTES: '1000' }), 1000);
  assert.equal(gate.resolveLineCap({ ZN_MCP_MAX_LINE_BYTES: String(def * 4) }), def);
  for (const bad of ['0', '-5', '1.5', 'abc', '', '1e3', '99999999999999999999999']) {
    assert.equal(gate.resolveLineCap({ ZN_MCP_MAX_LINE_BYTES: bad }), def, bad);
  }
});
