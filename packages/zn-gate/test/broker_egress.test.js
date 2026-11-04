'use strict';

// zn run --egress-allow: the local proxy, the environment it sets, and the
// refusals. Everything runs on 127.0.0.1; example.test resolves nowhere and
// is refused before any lookup.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const { Writable } = require('stream');

const { runBroker, parseRunArgs } = require('../lib/broker/run');
const egress = require('../lib/broker/egress');

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY'];

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of PROXY_KEYS) delete env[k];
  return { ...env, ...extra };
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.hits = 0;
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// A fake upstream on 127.0.0.1 that counts the requests it receives.
async function upstream() {
  const server = await listen((req, res) => {
    server.hits++;
    res.writeHead(200, { Connection: 'close', 'Content-Type': 'text/plain', 'Content-Length': 2 });
    res.end('ok');
  });
  return server;
}

function portOf(server) {
  return server.address().port;
}

// The child asks the proxy for each target and prints what came back.
const CHILD = `
const http = require('http');
const proxy = new URL(process.env.HTTP_PROXY);
const pp = Number(proxy.port);
const { ALLOW_PORT, REFUSED_PORT } = process.env;
function get(target) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: pp, method: 'GET', path: target, agent: false }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ error: e.code }));
    req.end();
  });
}
function connect(authority) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: pp, method: 'CONNECT', path: authority });
    req.on('connect', (res, sock) => {
      if (res.statusCode !== 200) { sock.destroy(); resolve({ status: res.statusCode }); return; }
      let b = '';
      sock.on('data', (d) => { b += d; });
      sock.on('end', () => resolve({ status: 200, body: b.split('\\r\\n\\r\\n')[1] }));
      sock.write('GET /ok HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n');
    });
    req.on('error', (e) => resolve({ error: e.code }));
    req.end();
  });
}
(async () => {
  const out = {
    allowed: await get('http://127.0.0.1:' + ALLOW_PORT + '/ok'),
    refused: await get('http://127.0.0.1:' + REFUSED_PORT + '/ok'),
    otherName: await get('http://localhost:' + ALLOW_PORT + '/ok'),
    connectAllowed: await connect('127.0.0.1:' + ALLOW_PORT),
    connectRefused: await connect('example.test:443'),
    env: { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY ?? null, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? null },
  };
  process.stdout.write(JSON.stringify(out));
})();
`;

test('parseAllowList: exact hosts, optional port, bad entries refused', () => {
  assert.deepEqual(egress.parseAllowList('api.example.com,Svc.Example.ORG:8443'), [
    { host: 'api.example.com', port: null },
    { host: 'svc.example.org', port: 8443 },
  ]);
  assert.deepEqual(egress.parseAllowList(['127.0.0.1:1']), [{ host: '127.0.0.1', port: 1 }]);
  for (const bad of ['', ' , ', '*.example.com', 'a b', 'example.com:0', 'example.com:99999', 'example.com:x', 'x'.repeat(300) + '.com']) {
    assert.throws(() => egress.parseAllowList(bad), (err) => err.code === 'ZN_USAGE', 'refuse ' + JSON.stringify(bad));
  }
});

test('isAllowed matches the exact host and the port only when one is listed', () => {
  const list = egress.parseAllowList('api.example.com,svc.example.org:8443');
  assert.equal(egress.isAllowed(list, 'api.example.com', 443), true);
  assert.equal(egress.isAllowed(list, 'API.example.com.', 80), true);
  assert.equal(egress.isAllowed(list, 'x.api.example.com', 443), false);
  assert.equal(egress.isAllowed(list, 'example.com', 443), false);
  assert.equal(egress.isAllowed(list, 'svc.example.org', 8443), true);
  assert.equal(egress.isAllowed(list, 'svc.example.org', 443), false);
});

test('parseRunArgs: --egress-allow is opt-in and does not change the parsed shape otherwise', () => {
  assert.deepEqual(parseRunArgs(['--', 'node', 'x.js']), { secrets: [], command: ['node', 'x.js'] });
  const p = parseRunArgs(['--egress-allow', 'a.example.com', '--egress-allow=b.example.com:443', '--', 'curl', 'x']);
  assert.equal(p.egressAllow.length, 2);
  assert.equal(p.egressAllow[1].port, 443);
  assert.equal(parseRunArgs(['--egress-allow', 'a.example.com', '--', 'curl']).command[0], 'curl');
});

test('without --egress-allow nothing changes: no proxy is set and the caller env is passed as is', async () => {
  const stdout = sink();
  const env = baseEnv({ HTTP_PROXY: 'http://caller.example.test:3128', NO_PROXY: 'example.test' });
  const code = await runBroker(['--', process.execPath, '-e',
    'process.stdout.write(JSON.stringify({ h: process.env.HTTP_PROXY ?? null, n: process.env.NO_PROXY ?? null, u: process.env.NODE_USE_ENV_PROXY ?? null, a: process.env.ALL_PROXY ?? null }))'],
  { env, stdout, stderr: sink() });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.text()), { h: 'http://caller.example.test:3128', n: 'example.test', u: null, a: null });
});

test('with --egress-allow: an allowed local host passes, a refused host gets 403 and is never contacted', async () => {
  const allowed = await upstream();
  const refused = await upstream();
  const stdout = sink();
  const stderr = sink();
  try {
    const env = baseEnv({ ALLOW_PORT: String(portOf(allowed)), REFUSED_PORT: String(portOf(refused)), NO_PROXY: 'example.test,127.0.0.1' });
    const code = await runBroker(['--egress-allow', '127.0.0.1:' + portOf(allowed), '--', process.execPath, '-e', CHILD],
      { env, stdout, stderr });
    assert.equal(code, 0, stderr.text());
    const r = JSON.parse(stdout.text());
    assert.deepEqual(r.allowed, { status: 200, body: 'ok' });
    assert.equal(r.refused.status, 403);
    assert.equal(r.otherName.status, 403, 'localhost is not 127.0.0.1: exact host only');
    assert.deepEqual(r.connectAllowed, { status: 200, body: 'ok' });
    assert.equal(r.connectRefused.status, 403);
    assert.equal(refused.hits, 0, 'the refused upstream was never reached');
    assert.equal(allowed.hits, 2, 'only the two allowed requests reached the upstream');
    // The child's caller-set NO_PROXY cannot route around the proxy.
    assert.equal(r.env.NO_PROXY, null);
    assert.equal(r.env.NODE_USE_ENV_PROXY, '1');
    assert.match(r.env.HTTP_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/);
    // Refusals are logged by host and port only.
    const log = stderr.text();
    assert.match(log, /egress refused 127\.0\.0\.1:\d+ \(not in --egress-allow\)/);
    assert.match(log, /egress refused example\.test:443/);
    assert.doesNotMatch(log, /\/ok|HTTP\/1\.1|Host:/);
  } finally {
    allowed.close();
    refused.close();
  }
});

test('the proxy port is closed when the child exits', async () => {
  const allowed = await upstream();
  try {
    const stdout = sink();
    const code = await runBroker(['--egress-allow', '127.0.0.1:' + portOf(allowed), '--', process.execPath, '-e',
      'process.stdout.write(process.env.HTTP_PROXY)'], { env: baseEnv(), stdout, stderr: sink() });
    assert.equal(code, 0);
    const port = Number(new URL(stdout.text()).port);
    await assert.rejects(new Promise((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(); });
      s.on('error', reject);
    }), (err) => err.code === 'ECONNREFUSED');
  } finally {
    allowed.close();
  }
});

test('a bad --egress-allow stops before the child starts (exit 64)', async () => {
  const stderr = sink();
  const code = await runBroker(['--egress-allow', '*.example.com', '--', process.execPath, '-e', 'process.exit(0)'],
    { env: baseEnv(), stdout: sink(), stderr });
  assert.equal(code, 64);
  assert.match(stderr.text(), /invalid --egress-allow entry/);
});

test('the proxy refuses a request that is not an absolute URL or CONNECT (no forwarding)', async () => {
  const proxy = await egress.startEgressProxy(egress.parseAllowList('127.0.0.1:9'), {});
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: proxy.port, path: '/' }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
    });
    assert.equal(status, 400);
  } finally {
    await proxy.close();
  }
});
