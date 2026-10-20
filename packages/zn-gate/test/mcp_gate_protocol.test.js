'use strict';

// Protocol edges of the zn-gate MCP server (lib/mcp.js), driven over stdio like a real client:
// malformed lines, unknown methods, missing params, odd argument shapes. Fictitious values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { tempDir } = require('./helpers/tmp');
const { generateAll } = require('./fixtures/fake_secrets');

const FAKE = generateAll(9101, { perType: 1, piiPerType: 1 });
const FAKE_AWS = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function startGate(t) {
  const home = tempDir(t, 'zn-gateproto-');
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ['ZN_LOCAL_ONLY', 'ZN_CLOUD', 'ZN_API_KEY']) delete env[k];
  const child = spawn(process.execPath, [CLI, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  t.after(() => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  }));
  const timeout = (id) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout waiting for id ' + id)), 8000).unref());
  const send = (raw, id) => {
    const p = new Promise((resolve) => waiters.set(id, resolve));
    child.stdin.write((typeof raw === 'string' ? raw : JSON.stringify(raw)) + '\n');
    return Promise.race([p, timeout(id)]);
  };
  return { child, send, call: (msg) => send(msg, msg.id) };
}

const toolCall = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const textOf = (r) => JSON.parse(r.result.content[0].text);

test('a line that is not JSON gets a -32700 parse error with a null id, and the server keeps working', async (t) => {
  const g = startGate(t);
  const bad = await g.send('{"jsonrpc": "2.0", "id": 1, "method": ', null);
  assert.equal(bad.error.code, -32700);
  assert.equal(bad.error.message, 'Parse error');
  assert.equal(bad.id, null);
  const ok = await g.call({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(ok.result, {});
});

test('blank lines are ignored; ping, initialize and notifications behave', async (t) => {
  const g = startGate(t);
  g.child.stdin.write('\n   \n');
  const init = await g.call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'zn-gate');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  // A notification has no reply: the next request is answered, nothing came before it.
  g.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const ping = await g.call({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(ping.result, {});
});

test('unknown methods: -32601 with an id, silence without one', async (t) => {
  const g = startGate(t);
  const r = await g.call({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  assert.equal(r.error.code, -32601);
  assert.match(r.error.message, /Unsupported method: resources\/list/);
  g.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'something/else' }) + '\n');
  const ping = await g.call({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(ping.result, {});
});

test('tools/list serves the four tools', async (t) => {
  const g = startGate(t);
  const r = await g.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(r.result.tools.map((x) => x.name).sort(), ['analyze_prompt', 'check_tool_call', 'check_tool_result', 'zn_status'].sort());
});

test('tools/call without params, or without a string name, is -32602', async (t) => {
  const g = startGate(t);
  const a = await g.call({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
  assert.equal(a.error.code, -32602);
  const b = await g.call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 42 } });
  assert.equal(b.error.code, -32602);
  const c = await g.call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { arguments: {} } });
  assert.equal(c.error.code, -32602);
});

test('tools/call with an unknown tool name is -32601', async (t) => {
  const g = startGate(t);
  const r = await g.call(toolCall(1, 'secrets_get', {}));
  assert.equal(r.error.code, -32601);
  assert.match(r.error.message, /secrets_get/);
});

test('analyze_prompt without text is a tool error; a non-string text is analyzed as empty', async (t) => {
  const g = startGate(t);
  const a = await g.call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'analyze_prompt' } });
  assert.ok(a.result, JSON.stringify(a));
  assert.equal(a.result.isError, true);
  assert.equal(textOf(a).error, 'ZN_BAD_ARGUMENTS');
  assert.match(textOf(a).message, /text/);
  const b = await g.call(toolCall(2, 'analyze_prompt', { text: 12345 }));
  assert.equal(b.result.isError, false);
  assert.equal(typeof textOf(b).verdict, 'string');
});

test('check_tool_call walks nested objects and arrays and redacts a fake key inside them', async (t) => {
  const g = startGate(t);
  const fakeKey = FAKE_AWS; // generated, fictitious
  const r = await g.call(toolCall(1, 'check_tool_call', {
    tool_name: 'http_post',
    arguments: { url: 'https://example.com/hook', headers: [{ name: 'x-id', value: fakeKey }], nested: { deep: ['ok', 7, null] } },
  }));
  const out = textOf(r);
  assert.equal(out.tool_name, 'http_post');
  assert.equal(typeof out.safe_to_execute, 'boolean');
  assert.equal(out.safe_to_execute, !r.result.isError);
  assert.ok(out.secrets_redacted >= 1);
  assert.ok(!JSON.stringify(out.sanitized_arguments).includes(fakeKey));
});

test('check_tool_call without a tool name or arguments is a tool error, never a safe verdict', async (t) => {
  const g = startGate(t);
  const r = await g.call(toolCall(1, 'check_tool_call', {}));
  assert.equal(r.result.isError, true);
  assert.equal(textOf(r).error, 'ZN_BAD_ARGUMENTS');
  assert.match(textOf(r).message, /tool_name, arguments/);
  assert.equal(textOf(r).safe_to_execute, undefined);
  const ok = await g.call(toolCall(2, 'check_tool_call', { tool_name: 'noop', arguments: {} }));
  assert.equal(textOf(ok).safe_to_execute, true);
});

test('check_tool_result takes structured content; missing content is a tool error, empty content is checked', async (t) => {
  const g = startGate(t);
  const a = await g.call(toolCall(1, 'check_tool_result', { tool_name: 'read_file', content: { lines: ['hello', 'world'], n: 2 } }));
  assert.equal(textOf(a).safe_to_ingest, true);
  const b = await g.call(toolCall(2, 'check_tool_result', {}));
  assert.equal(b.result.isError, true);
  assert.equal(textOf(b).error, 'ZN_BAD_ARGUMENTS');
  const c = await g.call(toolCall(3, 'check_tool_result', { tool_name: 'read_file', content: '' }));
  assert.equal(textOf(c).safe_to_ingest, true, 'an empty output is a value');
});

test('zn_status says local-only with no cloud and no network endpoint', async (t) => {
  const g = startGate(t);
  const r = await g.call(toolCall(1, 'zn_status', {}));
  const st = textOf(r);
  assert.equal(st.cloud_enabled, false);
  assert.equal(st.engine, 'local-rules');
  assert.equal(st.endpoint, 'none (local only)');
  assert.equal(st.leaves_machine, 'nothing');
});
