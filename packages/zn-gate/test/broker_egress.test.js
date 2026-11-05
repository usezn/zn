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
// Plain sockets, not http.request: with NODE_USE_ENV_PROXY=1 a Node.js child sends its own http requests through the proxy variable.
const net = require('net');
const proxy = new URL(process.env.HTTP_PROXY);
const pp = Number(proxy.port);
const { ALLOW_PORT, REFUSED_PORT } = process.env;
const statusOf = (text) => { const m = /^HTTP\\/1\\.[01] (\\d+)/.exec(text); return m ? Number(m[1]) : 0; };
function get(target) {
  return new Promise((resolve) => {
    const s = net.connect(pp, '127.0.0.1');
    let b = '';
    s.on('data', (d) => { b += d; });
    s.on('error', (e) => resolve({ error: e.code }));
    s.on('close', () => resolve({ status: statusOf(b), body: b.split('\\r\\n\\r\\n')[1] }));
    s.write('GET ' + target + ' HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n');
  });
}
function connect(authority) {
  return new Promise((resolve) => {
    const s = net.connect(pp, '127.0.0.1');
    let b = '';
    let sent = false;
    s.on('data', (d) => {
      b += d;
      if (!sent && b.includes('\\r\\n\\r\\n')) {
        if (statusOf(b) !== 200) { s.destroy(); resolve({ status: statusOf(b) }); return; }
        sent = true;
        s.write('GET /ok HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n');
      }
    });
    s.on('error', (e) => resolve({ error: e.code }));
    s.on('close', () => { if (sent) resolve({ status: 200, body: b.split('\\r\\n\\r\\n')[2] }); });
    s.write('CONNECT ' + authority + ' HTTP/1.1\\r\\nHost: ' + authority + '\\r\\n\\r\\n');
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

// Raw request through the proxy; resolves {status, headers}.
function viaProxy(proxy, { method = 'GET', path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method, path, headers, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('plain http: the upstream gets the listed target as Host, not the client Host header', async () => {
  let seenHost = null;
  const up = await listen((req, res) => { seenHost = req.headers.host; res.writeHead(200, { 'Content-Length': 2 }); res.end('ok'); });
  const proxy = await egress.startEgressProxy(egress.parseAllowList('127.0.0.1:' + portOf(up)), {});
  try {
    const r = await viaProxy(proxy, { path: 'http://127.0.0.1:' + portOf(up) + '/x', headers: { Host: 'evil.example.com' } });
    assert.equal(r.status, 200);
    assert.equal(seenHost, '127.0.0.1:' + portOf(up));
  } finally {
    await proxy.close();
    up.close();
  }
});

test('a client that aborts closes the upstream connection', async () => {
  let upstreamSocket = null;
  const up = await listen(() => { /* never answers */ });
  up.on('connection', (s) => { upstreamSocket = s; });
  const proxy = await egress.startEgressProxy(egress.parseAllowList('127.0.0.1:' + portOf(up)), {});
  try {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: 'http://127.0.0.1:' + portOf(up) + '/hang', agent: false });
    req.on('error', () => {});
    req.end();
    for (let i = 0; i < 100 && !upstreamSocket; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(upstreamSocket, 'the proxy reached the upstream');
    const closed = new Promise((resolve) => upstreamSocket.once('close', resolve));
    req.destroy();
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('upstream still open after the client aborted')), 3000))]);
  } finally {
    await proxy.close();
    up.close();
  }
});

test('CONNECT matches the host in upper case and with a trailing dot', async () => {
  const up = await upstream();
  const proxy = await egress.startEgressProxy(egress.parseAllowList('localhost:' + portOf(up)), {});
  try {
    for (const name of ['LOCALHOST', 'localhost.', 'LocalHost.']) {
      const status = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: name + ':' + portOf(up) });
        req.on('connect', (res, sock) => { sock.destroy(); resolve(res.statusCode); });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 200, name);
    }
  } finally {
    await proxy.close();
    up.close();
  }
});

test('a 30x redirect to a host that is not listed is returned to the client, not followed', async () => {
  const other = await upstream();
  const first = await listen((req, res) => {
    first.hits++;
    res.writeHead(302, { Location: 'http://127.0.0.1:' + portOf(other) + '/', 'Content-Length': 0 });
    res.end();
  });
  const proxy = await egress.startEgressProxy(egress.parseAllowList('127.0.0.1:' + portOf(first)), {});
  try {
    const r = await viaProxy(proxy, { path: 'http://127.0.0.1:' + portOf(first) + '/' });
    assert.equal(r.status, 302);
    assert.equal(first.hits, 1);
    assert.equal(other.hits, 0, 'the redirect target was never contacted');
    const refused = await viaProxy(proxy, { path: r.headers.location });
    assert.equal(refused.status, 403, 'following it by hand is refused');
    assert.equal(other.hits, 0);
  } finally {
    await proxy.close();
    first.close();
    other.close();
  }
});

test('egressEnv removes npm and global-agent proxy settings, in any case', () => {
  const env = egress.egressEnv({
    PATH: '/bin', npm_config_proxy: 'http://x.example.test', NPM_CONFIG_HTTPS_PROXY: 'http://x.example.test',
    npm_config_noproxy: 'example.test', GLOBAL_AGENT_HTTP_PROXY: 'http://x.example.test', global_agent_no_proxy: 'example.test',
    NO_PROXY: 'example.test', npm_config_registry: 'https://registry.example.test',
  }, 'http://127.0.0.1:1');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.npm_config_registry, 'https://registry.example.test', 'unrelated npm settings stay');
  for (const k of Object.keys(env)) assert.doesNotMatch(k, /^(npm_config_(proxy|https_proxy|noproxy)|global_agent_)/i, k);
  assert.equal(env.NO_PROXY, undefined);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1');
});
