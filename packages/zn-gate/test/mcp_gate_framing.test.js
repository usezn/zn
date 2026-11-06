'use strict';

// Message framing of lib/mcp.js over a fake stdin/stdout pair: the exact chunks written to the
// input are chosen by the test, not one line per write. Fake values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const ZN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-gateframing-'));
const SAVED = { ZN_HOME: process.env.ZN_HOME, ZN_CLOUD: process.env.ZN_CLOUD, ZN_API_KEY: process.env.ZN_API_KEY };
process.env.ZN_HOME = ZN_HOME;
delete process.env.ZN_CLOUD;
delete process.env.ZN_API_KEY;
test.after(() => {
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(ZN_HOME, { recursive: true, force: true });
});

const gate = require('../lib/mcp');

// Write each chunk as given (a tick apart), end the input and return the reply lines.
async function feed(chunks) {
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
    for (const c of chunks) {
      input.write(c);
      await new Promise((r) => setImmediate(r));
    }
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

const msg = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });

test('one message split across two chunks is answered once, after the newline', async () => {
  const line = msg(1, 'ping');
  const cut = Math.floor(line.length / 2);
  const replies = await feed([line.slice(0, cut), line.slice(cut) + '\n']);
  assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 1, result: {} }]);
});

test('a message split in the middle of a multi-byte character is read intact', async () => {
  const line = Buffer.from(msg('café-☃', 'ping') + '\n');
  const at = line.indexOf(0xe2) + 1; // inside the three bytes of the snowman
  const replies = await feed([line.subarray(0, at), line.subarray(at)]);
  assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 'café-☃', result: {} }]);
});

test('a message without a final newline is answered when the input ends', async () => {
  const replies = await feed([msg(2, 'ping')]);
  assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 2, result: {} }]);
});

test('two messages in one chunk are answered in order', async () => {
  const replies = await feed([msg(1, 'ping') + '\n' + msg(2, 'ping') + '\n']);
  assert.deepEqual(replies.map((r) => r.id), [1, 2]);
});

test('two messages and the start of a third in one chunk: the third waits for its end', async () => {
  const third = msg(3, 'ping');
  const replies = await feed([msg(1, 'ping') + '\n' + msg(2, 'ping') + '\n' + third.slice(0, 10), third.slice(10) + '\n']);
  assert.deepEqual(replies.map((r) => r.id), [1, 2, 3]);
});

test('CRLF line endings are accepted', async () => {
  const replies = await feed([msg(1, 'ping') + '\r\n' + msg(2, 'ping') + '\r\n']);
  assert.deepEqual(replies.map((r) => r.id), [1, 2]);
});

test('blank and whitespace-only lines produce no reply and do not stop the stream', async () => {
  const replies = await feed(['\n', '   \n', '\t\r\n', msg(1, 'ping') + '\n', '\n\n', msg(2, 'ping') + '\n']);
  assert.deepEqual(replies.map((r) => r.id), [1, 2]);
  assert.ok(replies.every((r) => !r.error));
});

test('a very long line (1 MiB of text) is read whole, in one chunk or many', async () => {
  const text = 'a'.repeat(1024 * 1024);
  const line = msg(1, 'tools/call', { name: 'check_tool_result', arguments: { tool_name: 'read_file', content: text } }) + '\n';
  const check = (replies) => {
    assert.equal(replies.length, 1);
    assert.equal(replies[0].id, 1);
    assert.equal(replies[0].error, undefined);
    const out = JSON.parse(replies[0].result.content[0].text);
    assert.equal(out.safe_to_ingest, true);
  };
  check(await feed([line]));
  const parts = [];
  for (let i = 0; i < line.length; i += 64 * 1024) parts.push(line.slice(i, i + 64 * 1024));
  check(await feed(parts.concat([msg(2, 'ping') + '\n'])).then((r) => { assert.equal(r[1].id, 2); return r.slice(0, 1); }));
});
