'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const { createSecretsServer, TOOLS } = require('../lib/broker/mcp');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { generateAll } = require('./fixtures/fake_secrets');
const { tempDir } = require('./helpers/tmp');

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

async function vaultWith(extra = {}) {
  const vault = createFakeVault();
  await vault.setSecret('GITHUB_TOKEN', GHP, { mode: 'proxy', allowHosts: ['127.0.0.1', 'api.github.com'], ...extra });
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
    const vault = await vaultWith({ allowIn: ['header', 'body'] });
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

test('secrets_http_request: markers only in headers unless the secret allows the URL or the body', async () => {
  const { server, seen, port } = await startServer();
  try {
    const vault = await vaultWith();
    const srv = createSecretsServer({ vault, engine: fakeEngine });
    // Probe: an injected prompt posts the token in a gist body to an allowed host.
    const gist = await call(srv, 'secrets_http_request', {
      method: 'POST', url: 'http://127.0.0.1:' + port + '/gists', headers: { Authorization: 'Bearer __ZN_GITHUB_TOKEN__' },
      body: JSON.stringify({ public: true, files: { 'a.txt': { content: '__ZN_GITHUB_TOKEN__' } } }),
    });
    assert.equal(gist.isError, true);
    assert.equal(gist.data.error, 'ZN_POLICY_DENIED');
    assert.match(gist.data.message, /only be sent in request headers/);
    assert.match(gist.data.message, /zn secret allow GITHUB_TOKEN --in body/);
    const q = await call(srv, 'secrets_http_request', { method: 'GET', url: 'http://127.0.0.1:' + port + '/x?access_token=__ZN_GITHUB_TOKEN__' });
    assert.equal(q.isError, true);
    assert.match(q.data.message, /--in query/);
    assert.equal(seen.length, 0, 'nothing was sent');
    assert.ok(vault.auditLog.some((e) => e.decision === 'deny' && /placement not allowed: body/.test(e.reason)));
    const ok = await call(srv, 'secrets_http_request', { method: 'GET', url: 'http://127.0.0.1:' + port + '/user', headers: { Authorization: 'Bearer __ZN_GITHUB_TOKEN__' } });
    assert.equal(ok.isError, false);
    assert.equal(seen.length, 1);
    const vq = await vaultWith({ allowIn: ['header', 'query'] });
    const srvq = createSecretsServer({ vault: vq, engine: fakeEngine });
    assert.equal((await call(srvq, 'secrets_http_request', { method: 'GET', url: 'http://127.0.0.1:' + port + '/x?access_token=__ZN_GITHUB_TOKEN__' })).isError, false);
    assert.ok(seen[1].url.includes(GHP));
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

test('secrets_render_file writes only to git-ignored paths and only file-mode secrets', async (t) => {
  const dir = tempDir(t, 'zn-render-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.npmrc\n');
  fs.writeFileSync(path.join(dir, 'npmrc.tpl'), '//registry.npmjs.org/:_authToken=__ZN_NPM_TOKEN__\n');
  // .npmrc holds a registry token: a credential file, so the user is asked.
  const vault = await vaultWith();
  vault.confirmFileWrite = async () => true;
  const srv = createSecretsServer({ vault, engine: fakeEngine, cwd: dir, home: dir });
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

test('secrets_render_file: only new files inside the project are written without asking', async (t) => {
  const base = tempDir(t, 'zn-render2-');
  const dir = path.join(base, 'proj');
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(dir);
  fs.mkdirSync(elsewhere);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.rc\nlinked/\n');
  fs.writeFileSync(path.join(dir, 'npmrc.tpl'), 'token=__ZN_NPM_TOKEN__\n');
  let answer = false;
  const vault = createFakeVault({ confirmFile: async () => answer });
  await vault.setSecret('NPM_TOKEN', NPM, { mode: 'file' });
  const srv = createSecretsServer({ vault, engine: fakeEngine, cwd: dir, home: base });

  // New file inside the project: written, nobody asked.
  const fresh = await call(srv, 'secrets_render_file', { template: 'npmrc.tpl', out: 'a.rc' });
  assert.equal(fresh.isError, false, JSON.stringify(fresh.data));
  assert.equal(vault.fileConfirmations.length, 0);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'a.rc')).mode & 0o777, 0o600);

  // Overwriting it: asked; declined leaves the file as it was.
  fs.writeFileSync(path.join(dir, 'a.rc'), 'mine\n');
  const over = await call(srv, 'secrets_render_file', { template: 'npmrc.tpl', out: 'a.rc' });
  assert.equal(over.isError, true);
  assert.match(over.data.message, /already exists.*did not confirm/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.rc'), 'utf8'), 'mine\n');

  // Outside the project: asked; declined writes nothing.
  const out = path.join(elsewhere, 'x.rc');
  const outside = await call(srv, 'secrets_render_file', { template: 'npmrc.tpl', out });
  assert.equal(outside.isError, true);
  assert.match(outside.data.message, /outside the project/);
  assert.ok(!fs.existsSync(out));

  // A directory inside the project that is a symlink to somewhere else counts as outside.
  if (process.platform !== 'win32') {
    fs.symlinkSync(elsewhere, path.join(dir, 'linked'));
    const viaLink = await call(srv, 'secrets_render_file', { template: 'npmrc.tpl', out: 'linked/y.rc' });
    assert.equal(viaLink.isError, true);
    assert.match(viaLink.data.message, /outside the project/);
    assert.ok(!fs.existsSync(path.join(elsewhere, 'y.rc')));
  }

  // Confirmed by the user: written.
  answer = true;
  const yes = await call(srv, 'secrets_render_file', { template: 'npmrc.tpl', out });
  assert.equal(yes.isError, false, JSON.stringify(yes.data));
  assert.equal(fs.readFileSync(out, 'utf8'), 'token=' + NPM + '\n');
  assert.ok(vault.fileConfirmations.every((c) => c.names.join() === 'NPM_TOKEN'));

  // A vault that cannot ask refuses instead of writing.
  const plain = createFakeVault();
  await plain.setSecret('NPM_TOKEN', NPM, { mode: 'file' });
  const srv2 = createSecretsServer({ vault: plain, engine: fakeEngine, cwd: dir, home: base });
  const noAsk = await call(srv2, 'secrets_render_file', { template: 'npmrc.tpl', out: path.join(elsewhere, 'z.rc') });
  assert.equal(noAsk.isError, true);
  assert.ok(!fs.existsSync(path.join(elsewhere, 'z.rc')));
});

test('secrets_render_file: a directory swapped for a link before the file is opened writes nothing outside', { skip: process.platform === 'win32' }, async (t) => {
  const base = tempDir(t, 'zn-render-race-');
  const dir = path.join(base, 'proj');
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.mkdirSync(elsewhere);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'sub/\n');
  fs.writeFileSync(path.join(dir, 'npmrc.tpl'), 'token=__ZN_NPM_TOKEN__\n');
  const vault = createFakeVault();
  await vault.setSecret('NPM_TOKEN', NPM, { mode: 'file' });
  // The first lookup happens after the path checks passed and before the file is opened.
  const resolve = vault.resolve;
  let swapped = false;
  vault.resolve = async (...a) => {
    if (!swapped) {
      swapped = true;
      fs.renameSync(path.join(dir, 'sub'), path.join(dir, 'sub-moved'));
      fs.symlinkSync(elsewhere, path.join(dir, 'sub'));
    }
    return resolve(...a);
  };
  const srv = createSecretsServer({ vault, engine: fakeEngine, cwd: dir, home: base });
  const r = await call(srv, 'secrets_render_file', { template: 'npmrc.tpl', out: 'sub/a.rc' });
  assert.equal(r.isError, true);
  assert.match(r.data.message, /resolves outside the project/);
  assert.ok(!fs.existsSync(path.join(elsewhere, 'a.rc')), 'nothing may be left outside the project');
  assert.ok(!fs.existsSync(path.join(dir, 'sub-moved', 'a.rc')));
});

test('secrets_render_file: the approved location is checked again after the user answers', { skip: process.platform === 'win32' }, async (t) => {
  const base = tempDir(t, 'zn-render-confirm-');
  const dir = path.join(base, 'proj');
  const first = path.join(base, 'first');
  const second = path.join(base, 'second');
  fs.mkdirSync(dir);
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.rc\n');
  fs.writeFileSync(path.join(dir, 'npmrc.tpl'), 'token=__ZN_NPM_TOKEN__\n');
  fs.symlinkSync(first, path.join(dir, 'link'));
  // The user is asked about the real location; while they answer, the link moves.
  const vault = createFakeVault({
    confirmFile: async () => {
      fs.unlinkSync(path.join(dir, 'link'));
      fs.symlinkSync(second, path.join(dir, 'link'));
      return true;
    },
  });
  await vault.setSecret('NPM_TOKEN', NPM, { mode: 'file' });
  const srv = createSecretsServer({ vault, engine: fakeEngine, cwd: dir, home: base });
  const r = await call(srv, 'secrets_render_file', { template: 'npmrc.tpl', out: 'link/x.rc' });
  assert.equal(r.isError, true);
  assert.match(r.data.message, /different location/);
  assert.ok(!fs.existsSync(path.join(first, 'x.rc')));
  assert.ok(!fs.existsSync(path.join(second, 'x.rc')));
  // The dialog named the real path, not the name the agent typed.
  assert.equal(vault.fileConfirmations[0].file, path.join(fs.realpathSync(first), 'x.rc'));
});

test('secrets_render_file: an approved overwrite replaces the file in place with mode 0600', { skip: process.platform === 'win32' }, async (t) => {
  const base = tempDir(t, 'zn-render-over-');
  const dir = path.join(base, 'proj');
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(dir);
  fs.mkdirSync(elsewhere);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.rc\n');
  fs.writeFileSync(path.join(dir, 'npmrc.tpl'), 'token=__ZN_NPM_TOKEN__\n');
  const target = path.join(elsewhere, 'old.rc');
  fs.writeFileSync(target, 'an old and much longer line of content that must not survive\n', { mode: 0o644 });
  const vault = createFakeVault({ confirmFile: async () => true });
  await vault.setSecret('NPM_TOKEN', NPM, { mode: 'file' });
  const srv = createSecretsServer({ vault, engine: fakeEngine, cwd: dir, home: base });
  const r = await call(srv, 'secrets_render_file', { template: 'npmrc.tpl', out: target });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(fs.readFileSync(target, 'utf8'), 'token=' + NPM + '\n');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('secrets_request records the ask and refuses values', async (t) => {
  const home = tempDir(t, 'zn-req-');
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

/* zn Team: the vault applies the organization policy in listSecrets({effective: true}). */
function withOrg(vault, name, fields) {
  const list = vault.listSecrets.bind(vault);
  vault.listSecrets = async (o) => (await list(o)).map((s) => (s.name === name ? { ...s, ...fields } : s));
  return vault;
}

test('secrets_http_request: a warn rule sends the request, tells the agent and the user, records "warn"', async () => {
  const { server, seen, port } = await startServer();
  try {
    const vault = withOrg(await vaultWith(), 'GITHUB_TOKEN', { warn: true, warnReason: 'GitHub tokens need review' });
    const told = [];
    const srv = createSecretsServer({ vault, engine: fakeEngine, notify: (l) => told.push(l) });
    const r = await call(srv, 'secrets_http_request', { method: 'GET', url: 'http://127.0.0.1:' + port + '/x', headers: { Authorization: 'Bearer __ZN_GITHUB_TOKEN__' } });
    assert.equal(r.isError, false, JSON.stringify(r.data));
    assert.equal(seen.length, 1);
    const notice = 'zn: your team policy would block GITHUB_TOKEN here (policy note: "GitHub tokens need review"). It was allowed and recorded for your organization.';
    assert.equal(r.data.notice, notice);
    assert.deepEqual(told, [notice]);
    const uses = vault.auditLog.filter((e) => e.secret === 'GITHUB_TOKEN' && e.tool === 'mcp:secrets_http_request');
    assert.deepEqual(uses.map((e) => [e.decision, e.reason, e.host]), [['warn', 'policy:warn', '127.0.0.1']]);
  } finally {
    server.close();
  }
});

test('secrets_http_request: without a warn rule there is no notice', async () => {
  const { server, port } = await startServer();
  try {
    const srv = createSecretsServer({ vault: await vaultWith(), engine: fakeEngine, notify: () => assert.fail('no notice expected') });
    const r = await call(srv, 'secrets_http_request', { method: 'GET', url: 'http://127.0.0.1:' + port + '/x', headers: { Authorization: 'Bearer __ZN_GITHUB_TOKEN__' } });
    assert.equal(r.isError, false);
    assert.equal(r.data.notice, undefined);
  } finally {
    server.close();
  }
});

test('secrets_render_file: an organization deny blocks, a warn rule writes and says so', async (t) => {
  const dir = tempDir(t, 'zn-render-org-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'out.rc\nout2.rc\n');
  fs.writeFileSync(path.join(dir, 'npmrc.tpl'), '//registry.npmjs.org/:_authToken=__ZN_NPM_TOKEN__\n');
  const denyVault = withOrg(await vaultWith(), 'NPM_TOKEN', { deny: true, denyReason: 'policy:org_deny' });
  denyVault.confirmFileWrite = async () => true;
  const no = await call(createSecretsServer({ vault: denyVault, engine: fakeEngine, cwd: dir, home: dir }), 'secrets_render_file', { template: 'npmrc.tpl', out: 'out.rc' });
  assert.equal(no.isError, true);
  assert.match(no.data.message, /organization policy/);
  assert.ok(!fs.existsSync(path.join(dir, 'out.rc')));
  assert.ok(denyVault.auditLog.some((e) => e.secret === 'NPM_TOKEN' && e.decision === 'deny' && e.reason === 'policy:org_deny'));

  const warnVault = withOrg(await vaultWith(), 'NPM_TOKEN', { warn: true, warnReason: 'Registry tokens need review' });
  warnVault.confirmFileWrite = async () => true;
  const told = [];
  const yes = await call(createSecretsServer({ vault: warnVault, engine: fakeEngine, cwd: dir, home: dir, notify: (l) => told.push(l) }), 'secrets_render_file', { template: 'npmrc.tpl', out: 'out2.rc' });
  assert.equal(yes.isError, false, JSON.stringify(yes.data));
  assert.equal(fs.readFileSync(path.join(dir, 'out2.rc'), 'utf8'), '//registry.npmjs.org/:_authToken=' + NPM + '\n');
  assert.match(yes.data.notice, /^zn: your team policy would block NPM_TOKEN here \(policy note: "Registry tokens need review"\)\. It was allowed/);
  assert.equal(told.length, 1);
  const uses = warnVault.auditLog.filter((e) => e.secret === 'NPM_TOKEN' && e.tool === 'mcp:secrets_render_file');
  assert.deepEqual(uses.map((e) => [e.decision, e.reason]), [['warn', 'policy:warn']]);
});
