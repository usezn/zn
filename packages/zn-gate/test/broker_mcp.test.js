'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const { createSecretsServer, TOOLS } = require('../lib/broker/mcp');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { generateAll } = require('./fixtures/fake_secrets');

const FAKE = generateAll(9001, { perType: 1, piiPerType: 1 });
const GHP = FAKE.secrets.find((s) => s.type === 'github_pat_classic').value;
const NPM = FAKE.secrets.find((s) => s.type === 'npm_access_token').value;
const OTHER = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;

function startServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-echo', String(req.headers.authorization || ''));
      // Reflect the token and leak an unrelated secret: both must be scrubbed.
      res.end(JSON.stringify({ you_sent: req.headers.authorization, other: OTHER, ok: true }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

async function vaultWith() {
  const vault = createFakeVault();
  await vault.setSecret('GITHUB_TOKEN', GHP, { mode: 'proxy', allowHosts: ['127.0.0.1', 'api.github.com'] });
  await vault.setSecret('NPM_TOKEN', NPM, { mode: 'file' });
  return vault;
}

function call(srv, name, args) {
  return srv.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    .then((r) => ({ isError: r.result.isError, data: JSON.parse(r.result.content[0].text) }));
}

test('tools: list, http_request, render_file, request, and no get', async () => {
  const srv = createSecretsServer({ vault: await vaultWith(), engine: fakeEngine });
  const res = await srv.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['secrets_http_request', 'secrets_list', 'secrets_render_file', 'secrets_request']);
  for (const t of TOOLS) {
    assert.match(t.description, /no tool that returns a secret value/);
    assert.ok(!/get/i.test(t.name));
  }
  const get = await srv.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'secrets_get', arguments: { name: 'GITHUB_TOKEN' } } });
  assert.equal(get.error.code, -32601);
  const init = await srv.handleMessage({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'zn-secrets');
});

test('secrets_list never returns values', async () => {
  const srv = createSecretsServer({ vault: await vaultWith(), engine: fakeEngine });
  const r = await call(srv, 'secrets_list', {});
  assert.equal(r.isError, false);
  assert.deepEqual(r.data.secrets.map((s) => s.marker), ['__ZN_GITHUB_TOKEN__', '__ZN_NPM_TOKEN__']);
  const text = JSON.stringify(r.data);
  assert.ok(!text.includes(GHP) && !text.includes(NPM));
});

test('secrets_http_request substitutes for an allowed host and scrubs the response', async () => {
  const { server, seen, port } = await startServer();
  try {
    const vault = await vaultWith();
    const srv = createSecretsServer({ vault, engine: fakeEngine });
    const r = await call(srv, 'secrets_http_request', {
      method: 'POST', url: 'http://127.0.0.1:' + port + '/user', headers: { Authorization: 'Bearer __ZN_GITHUB_TOKEN__' }, body: '{"t":"__ZN_GITHUB_TOKEN__"}',
    });
    assert.equal(r.isError, false, JSON.stringify(r.data));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, 'Bearer ' + GHP, 'server received the real value');
    assert.equal(seen[0].body, '{"t":"' + GHP + '"}');
    const out = JSON.stringify(r.data);
    assert.ok(!out.includes(GHP), 'reflected token scrubbed');
    assert.ok(!out.includes(OTHER), 'unrelated secret scrubbed by the engine');
    assert.equal(r.data.status, 200);
    assert.match(r.data.body, /__ZN_GITHUB_TOKEN__/);
    assert.equal(r.data.headers['x-echo'], 'Bearer __ZN_GITHUB_TOKEN__');
    assert.ok(vault.auditLog.some((e) => e.decision === 'allow' && e.host === '127.0.0.1'));
  } finally {
    server.close();
  }
});

test('secrets_http_request refuses hosts outside allowHosts without sending anything', async () => {
  const { server, seen, port } = await startServer();
  try {
    const vault = createFakeVault();
    await vault.setSecret('GITHUB_TOKEN', GHP, { mode: 'proxy', allowHosts: ['api.github.com'] });
    const srv = createSecretsServer({ vault, engine: fakeEngine, fetch: async () => { throw new Error('must not be called'); } });
    const r = await call(srv, 'secrets_http_request', { method: 'GET', url: 'http://localhost:' + port + '/?k=__ZN_GITHUB_TOKEN__' });
    assert.equal(r.isError, true);
    assert.equal(r.data.error, 'ZN_POLICY_DENIED');
    assert.match(r.data.message, /No request was made/);
    assert.equal(seen.length, 0);
    assert.ok(vault.auditLog.some((e) => e.decision === 'deny' && e.host === 'localhost'));
  } finally {
    server.close();
  }
});

test('secrets_http_request input checks', async () => {
  const srv = createSecretsServer({ vault: await vaultWith(), engine: fakeEngine, fetch: async () => { throw new Error('must not be called'); } });
  const cases = [
    [{ method: 'GET', url: 'http://api.github.com/user' }, /https/],
    [{ method: 'GET', url: 'https://u:p@api.github.com/' }, /userinfo/],
    [{ method: 'GET', url: 'https://api.github.com/', headers: { Host: 'evil.example' } }, /Host cannot be set/],
    [{ method: 'GET', url: 'https://api.github.com/?k=__ZN_AWS_KEY_1__' }, /zn secret adopt AWS_KEY_1/],
    [{ method: 'G E T', url: 'https://api.github.com/' }, /method/],
  ];
  for (const [args, re] of cases) {
    const r = await call(srv, 'secrets_http_request', args);
    assert.equal(r.isError, true);
    assert.match(r.data.message, re);
  }
  const nf = await call(srv, 'secrets_http_request', { method: 'GET', url: 'https://api.github.com/?k=__ZN_MISSING__' });
  assert.equal(nf.data.error, 'ZN_NOT_FOUND');
});

test('secrets_render_file writes only to git-ignored paths and only file-mode secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-render-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.npmrc\n');
  fs.writeFileSync(path.join(dir, 'npmrc.tpl'), '//registry.npmjs.org/:_authToken=__ZN_NPM_TOKEN__\n');
  const srv = createSecretsServer({ vault: await vaultWith(), engine: fakeEngine, cwd: dir, home: dir });
  const ok = await call(srv, 'secrets_render_file', { template: 'npmrc.tpl', out: '.npmrc' });
  assert.equal(ok.isError, false, JSON.stringify(ok.data));
  assert.equal(fs.readFileSync(path.join(dir, '.npmrc'), 'utf8'), '//registry.npmjs.org/:_authToken=' + NPM + '\n');
  assert.ok(!JSON.stringify(ok.data).includes(NPM));
  const tracked = await call(srv, 'secrets_render_file', { template: 'npmrc.tpl', out: 'config/npmrc' });
  assert.equal(tracked.isError, true);
  assert.match(tracked.data.message, /tracked by git/);
  fs.writeFileSync(path.join(dir, 'gh.tpl'), 'token: __ZN_GITHUB_TOKEN__\n');
  const proxy = await call(srv, 'secrets_render_file', { template: 'gh.tpl', out: '.npmrc' });
  assert.match(proxy.data.message, /only "file" mode/);
});

test('secrets_request records the ask and refuses values', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-req-'));
  const lines = [];
  const srv = createSecretsServer({ vault: await vaultWith(), engine: fakeEngine, home, notify: (l) => lines.push(l) });
  const r = await call(srv, 'secrets_request', { name: 'STRIPE_API_KEY', reason: 'create a test charge' });
  assert.equal(r.isError, false);
  assert.match(r.data.message, /zn secret set STRIPE_API_KEY/);
  assert.match(lines[0], /STRIPE_API_KEY/);
  assert.match(fs.readFileSync(path.join(home, '.zn', 'requests.jsonl'), 'utf8'), /STRIPE_API_KEY/);
  const v = await call(srv, 'secrets_request', { name: 'STRIPE_API_KEY', reason: 'x', value: 'sk_live_x' });
  assert.equal(v.isError, true);
  assert.match(v.data.message, /never takes a value/);
});

test('zn secrets-mcp speaks JSON-RPC over stdio', async () => {
  const cli = path.join(__dirname, '..', 'bin', 'cli.js');
  const child = spawn(process.execPath, [cli, 'secrets-mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
  assert.equal(lines[0].result.serverInfo.name, 'zn-secrets');
  assert.equal(lines[1].result.tools.length, 4);
});
