'use strict';

// The self-test is documented as never using the network. These tests run it
// with proxy variables pointing at a dead local port and record every attempt
// to open a connection or resolve a name from inside the child process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

function deadPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Preload that logs network use to the file named by ZN_TEST_NET_LOG.
const PRELOAD = `
'use strict';
const fs = require('fs');
const log = (what) => fs.appendFileSync(process.env.ZN_TEST_NET_LOG, what + '\\n');
const net = require('net');
const dns = require('dns');
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) { log('connect'); return origConnect.apply(this, a); };
for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  const orig = dns[fn];
  dns[fn] = function (...a) { log('dns.' + fn); return orig.apply(this, a); };
}
if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = function () { log('fetch'); return Promise.reject(new Error('blocked')); };
}
`;

async function runSelfTest(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-selftest-'));
  try {
    const port = await deadPort();
    const proxy = `http://127.0.0.1:${port}`;
    const preload = path.join(dir, 'preload.js');
    const netLog = path.join(dir, 'net.log');
    fs.writeFileSync(preload, PRELOAD);
    fs.writeFileSync(netLog, '');
    const env = {
      ...process.env,
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      ZN_LOCAL_ONLY: 'true',
      ZN_TEST_NET_LOG: netLog,
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
      HOME: dir,
      USERPROFILE: dir,
      ...extraEnv,
    };
    if (!('ZN_API_KEY' in extraEnv)) delete env.ZN_API_KEY;
    if (!('ZN_CLOUD' in extraEnv)) delete env.ZN_CLOUD;
    const r = spawnSync(process.execPath, [CLI, 'test'], { encoding: 'utf8', env, cwd: dir, timeout: 60000 });
    return { r, attempts: fs.readFileSync(netLog, 'utf8').split('\n').filter(Boolean) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('self-test with dead proxies and ZN_LOCAL_ONLY exits 0 and passes every vector', async () => {
  const { r } = await runSelfTest();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /FAILED/);
  const m = r.stdout.match(/Summary\s+: (\d+)\/(\d+) vectors passed \(100\.0%\)/);
  assert.ok(m, r.stdout);
  assert.equal(m[1], m[2]);
  assert.match(r.stdout, /ALL TESTS PASSED \(100%\)/);
  assert.match(r.stdout, /never uses the network/);
});

test('self-test with dead proxies opens no connection and resolves no name', async () => {
  const { r, attempts } = await runSelfTest();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(attempts, []);
});

test('self-test stays offline even when a cloud key and cloud mode are set', async () => {
  const { r, attempts } = await runSelfTest({ ZN_API_KEY: 'zn_test_notarealkey_0000', ZN_CLOUD: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(attempts, []);
});

test('the network recorder does detect a connection (sanity check)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-selftest-'));
  try {
    const preload = path.join(dir, 'preload.js');
    const netLog = path.join(dir, 'net.log');
    fs.writeFileSync(preload, PRELOAD);
    fs.writeFileSync(netLog, '');
    const port = await deadPort();
    const code = `const s=require('net').connect(${port},'127.0.0.1');s.on('error',()=>{});s.destroy();`;
    spawnSync(process.execPath, ['-e', code], {
      env: { ...process.env, ZN_TEST_NET_LOG: netLog, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
      timeout: 20000,
    });
    assert.ok(fs.readFileSync(netLog, 'utf8').includes('connect'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
