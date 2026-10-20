'use strict';

// handleRequest of the zn-gate MCP server (lib/mcp.js) called in process, so the branches count in
// coverage. Replies are captured from process.stdout.write; anything else is passed through.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Local counts are written under ZN_HOME: keep them out of the real home.
const ZN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-gatehandle-'));
const SAVED_ZN_HOME = process.env.ZN_HOME;
process.env.ZN_HOME = ZN_HOME;
test.after(() => {
  if (SAVED_ZN_HOME === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = SAVED_ZN_HOME;
  fs.rmSync(ZN_HOME, { recursive: true, force: true });
});

const gate = require('../lib/mcp');

async function ask(message, options = { localOnly: true }) {
  const replies = [];
  const real = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk === 'string' && chunk.startsWith('{"jsonrpc":"2.0"')) { replies.push(JSON.parse(chunk)); return true; }
    return real.call(process.stdout, chunk, ...rest);
  };
  try {
    await gate.handleRequest(message, options);
  } finally {
    process.stdout.write = real;
  }
  return replies;
}

test('initialize reports the server name, version and protocol', async () => {
  const [r] = await ask({ id: 1, method: 'initialize' });
  assert.equal(r.result.serverInfo.name, gate.SERVER_NAME);
  assert.equal(r.result.serverInfo.version, gate.SERVER_VERSION);
  assert.equal(r.result.protocolVersion, gate.PROTOCOL_VERSION);
});

test('notifications and unknown notifications produce no reply; unknown methods with an id get -32601', async () => {
  assert.deepEqual(await ask({ method: 'notifications/initialized' }), []);
  assert.deepEqual(await ask({ method: 'unknown/notification' }), []);
  const [r] = await ask({ id: 'abc', method: 'prompts/list' });
  assert.equal(r.id, 'abc');
  assert.equal(r.error.code, -32601);
});

test('tools/call with missing params or a non-string name is -32602, with the request id', async () => {
  const [a] = await ask({ id: 1, method: 'tools/call' });
  assert.equal(a.error.code, -32602);
  const [b] = await ask({ id: 2, method: 'tools/call', params: { name: null } });
  assert.equal(b.id, 2);
  assert.equal(b.error.code, -32602);
});

test('tools/call with an unknown tool names the tool: -32601 up to 2025-03-26, -32602 from 2025-06-18', async () => {
  for (const [version, code] of [['2025-03-26', -32601], ['2025-06-18', -32602], ['2025-11-25', -32602]]) {
    await ask({ id: 0, method: 'initialize', params: { protocolVersion: version } });
    const [r] = await ask({ id: 1, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } });
    assert.equal(r.error.code, code, version);
    assert.match(r.error.message, /delete_everything/);
  }
});

test('zn_status without the cloud check says nothing leaves the machine', async () => {
  const saved = { ...process.env };
  try {
    delete process.env.ZN_CLOUD;
    delete process.env.ZN_API_KEY;
    const [r] = await ask({ id: 1, method: 'tools/call', params: { name: 'zn_status' } }, {});
    const st = JSON.parse(r.result.content[0].text);
    assert.equal(st.cloud_enabled, false);
    assert.equal(st.leaves_machine, 'nothing');
  } finally {
    for (const k of ['ZN_CLOUD', 'ZN_API_KEY']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

test('check_tool_result with a non-string, non-undefined content is serialized and checked', async () => {
  const [r] = await ask({ id: 1, method: 'tools/call', params: { name: 'check_tool_result', arguments: { tool_name: 'read_file', content: { a: [1, 2, 3] } } } });
  const out = JSON.parse(r.result.content[0].text);
  assert.equal(out.safe_to_ingest, true);
  assert.equal(r.result.isError, false);
});

test('check_tool_call: short strings are skipped and arguments of other types do not fail', async () => {
  const [r] = await ask({ id: 1, method: 'tools/call', params: { name: 'check_tool_call', arguments: { tool_name: 'list_dir', arguments: { path: 'src', depth: 2, flags: [true, null, 'ab'] } } } });
  const out = JSON.parse(r.result.content[0].text);
  assert.equal(out.safe_to_execute, true);
  assert.equal(out.tool_name, 'list_dir');
});

test('analyze_prompt with a non-string text is analyzed as empty text', async () => {
  const [r] = await ask({ id: 1, method: 'tools/call', params: { name: 'analyze_prompt', arguments: { text: { not: 'a string' } } } });
  assert.equal(r.result.isError, false);
  assert.equal(typeof JSON.parse(r.result.content[0].text).verdict, 'string');
});
