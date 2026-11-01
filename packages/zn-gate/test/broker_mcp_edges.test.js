'use strict';

// Edges of the secrets MCP server (lib/broker/mcp.js): protocol replies, errors thrown by the vault,
// failed requests and a malformed line on stdio. Fake vault and fictitious values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const { createSecretsServer } = require('../lib/broker/mcp');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const FAKE_TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

async function vaultWithToken() {
  const vault = createFakeVault();
  await vault.setSecret('DEMO_TOKEN', FAKE_TOKEN, { mode: 'proxy', allowHosts: ['127.0.0.1'] });
  return vault;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

test('handleMessage: ping, notifications, odd messages and unknown methods', async () => {
  const srv = createSecretsServer({ vault: createFakeVault(), engine: fakeEngine });
  assert.deepEqual((await srv.handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping' })).result, {});
  assert.equal(await srv.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await srv.handleMessage(null), null, 'a null message is dropped');
  assert.equal(await srv.handleMessage({ jsonrpc: '2.0', method: 'whatever/else' }), null, 'unknown notification: no reply');
  const r = await srv.handleMessage({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
  assert.equal(r.id, 7);
  assert.equal(r.error.code, -32601);
  assert.equal(r.error.message, 'Unsupported method');
});

test('handleMessage: an unknown method or tool with odd text is not echoed back', async () => {
  const srv = createSecretsServer({ vault: createFakeVault(), engine: fakeEngine });
  const weird = 'x ' + FAKE_TOKEN + ' <y>';
  const m = await srv.handleMessage({ jsonrpc: '2.0', id: 9, method: weird });
  assert.equal(m.error.message, 'Unsupported method');
  assert.ok(!JSON.stringify(m).includes(FAKE_TOKEN.slice(0, 12)));
  const tool = await srv.handleMessage({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: weird, arguments: {} } });
  assert.ok(!JSON.stringify(tool).includes(FAKE_TOKEN.slice(0, 12)));
});

test('handleMessage: tools/call without params or a string name is -32602', async () => {
  const srv = createSecretsServer({ vault: createFakeVault(), engine: fakeEngine });
  const a = await srv.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
  assert.equal(a.error.code, -32602);
  const b = await srv.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: ['secrets_list'] } });
  assert.equal(b.error.code, -32602);
});

test('an error thrown by the vault becomes an error result; ZN_ codes are kept, others are ZN_ERROR', async () => {
  const coded = createFakeVault();
  coded.listSecrets = async () => { const e = new Error('vault is locked'); e.code = 'ZN_VAULT_LOCKED'; throw e; };
  const srv1 = createSecretsServer({ vault: coded, engine: fakeEngine });
  const r1 = await srv1.callTool('secrets_list', {});
  assert.equal(r1.isError, true);
  assert.deepEqual(JSON.parse(r1.content[0].text), { error: 'ZN_VAULT_LOCKED', message: 'vault is locked' });

  const plain = createFakeVault();
  plain.listSecrets = async () => { const e = new Error('disk on fire'); e.code = 'EIO'; throw e; };
  const srv2 = createSecretsServer({ vault: plain, engine: fakeEngine });
  const r2 = await srv2.callTool('secrets_list', {});
  assert.equal(JSON.parse(r2.content[0].text).error, 'ZN_ERROR');

  const bare = createFakeVault();
  bare.listSecrets = async () => { throw 'just a string'; };
  const srv3 = createSecretsServer({ vault: bare, engine: fakeEngine });
  const r3 = await srv3.callTool('secrets_list', {});
  assert.deepEqual(JSON.parse(r3.content[0].text), { error: 'ZN_ERROR', message: 'just a string' });
});

test('callTool returns null for an unknown tool name', async () => {
  const srv = createSecretsServer({ vault: createFakeVault(), engine: fakeEngine });
  assert.equal(await srv.callTool('secrets_get', {}), null);
});

test('secrets_http_request: a failed request is an error result, audited, and does not echo the secret', async () => {
  const port = await freePort(); // nothing listens here
  const vault = await vaultWithToken();
  const srv = createSecretsServer({ vault, engine: fakeEngine, notify: () => {} });
  const r = await srv.callTool('secrets_http_request', {
    method: 'GET', url: 'http://127.0.0.1:' + port + '/x', headers: { Authorization: 'Bearer __ZN_DEMO_TOKEN__' },
  });
  assert.equal(r.isError, true);
  const data = JSON.parse(r.content[0].text);
  assert.equal(data.error, 'ZN_HTTP_ERROR');
  assert.ok(!r.content[0].text.includes(FAKE_TOKEN));
  const last = vault.auditLog[vault.auditLog.length - 1];
  assert.equal(last.tool, 'mcp:secrets_http_request');
  assert.equal(last.reason, 'request failed');
});

test('secrets_http_request: a fetch that throws a message holding the secret is scrubbed', async () => {
  const vault = await vaultWithToken();
  const srv = createSecretsServer({
    vault, engine: fakeEngine, notify: () => {},
    fetch: async (url, init) => { throw new Error('connect failed with ' + init.headers.Authorization); },
  });
  const r = await srv.callTool('secrets_http_request', {
    method: 'GET', url: 'http://127.0.0.1:9/x', headers: { Authorization: 'Bearer __ZN_DEMO_TOKEN__' },
  });
  assert.equal(r.isError, true);
  assert.equal(JSON.parse(r.content[0].text).error, 'ZN_HTTP_ERROR');
  assert.ok(!r.content[0].text.includes(FAKE_TOKEN));
});

test('secrets_request: invalid names are refused and a reason is cut and cleaned', async (t) => {
  const home = tempDir(t, 'zn-req-');
  const srv = createSecretsServer({ vault: createFakeVault(), engine: fakeEngine, home, notify: () => {} });
  const bad = await srv.callTool('secrets_request', { name: 'not a valid name!' });
  assert.equal(bad.isError, true);
  assert.match(JSON.parse(bad.content[0].text).message, /invalid name/);
  const empty = await srv.callTool('secrets_request', {});
  assert.equal(empty.isError, true);
  const ok = await srv.callTool('secrets_request', { name: 'DEMO_KEY', reason: 'a\nb\u0007' + 'x'.repeat(500) });
  assert.equal(ok.isError, false);
  const rec = JSON.parse(fs.readFileSync(path.join(home, '.zn', 'requests.jsonl'), 'utf8').trim());
  assert.equal(rec.name, 'DEMO_KEY');
  assert.equal(rec.reason.length, 300);
  assert.ok(!/[\u0000-\u001f]/.test(rec.reason));
});

test('secrets_render_file: an out path that runs through a regular file is refused before anything is written', async (t) => {
  // The refusal comes from the earlier lstat check (ENOTDIR); the mkdir failure branch of openRenderTarget stays uncovered on purpose.
  const dir = tempDir(t, 'zn-render-dir-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'blocker/\n');
  fs.writeFileSync(path.join(dir, 'blocker'), 'i am a file, not a directory');
  fs.writeFileSync(path.join(dir, 'x.tpl'), 'k=__ZN_DEMO_FILE__\n');
  const vault = createFakeVault();
  await vault.setSecret('DEMO_FILE', 'demo-' + 'z'.repeat(20), { mode: 'file' });
  vault.confirmFileWrite = async () => true;
  const srv = createSecretsServer({ vault, engine: fakeEngine, cwd: dir, home: dir, notify: () => {} });
  const r = await srv.callTool('secrets_render_file', { template: 'x.tpl', out: 'blocker/sub/out.env' });
  assert.equal(r.isError, true, r.content[0].text);
  assert.ok(!fs.existsSync(path.join(dir, 'blocker', 'sub')));
  assert.ok(!r.content[0].text.includes('demo-zzzz'));
});

test('secrets-mcp over stdio: a malformed line gets a parse error with a null id and the server goes on', async () => {
  const cli = path.join(__dirname, '..', 'bin', 'cli.js');
  const child = spawn(process.execPath, [cli, 'secrets-mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  child.stdin.write('this is not json ' + FAKE_TOKEN + '\n\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].error.code, -32700);
  assert.equal(lines[0].id, null);
  assert.ok(!JSON.stringify(lines[0]).includes(FAKE_TOKEN.slice(0, 12)));
  assert.deepEqual(lines[1].result, {});
});
