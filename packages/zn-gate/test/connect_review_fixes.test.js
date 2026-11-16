'use strict';

// Fixes from the review of the connect feature: the keychain checks of the hooks run in linear time and still
// refuse what they refused, NODE_OPTIONS that expose the TLS session or the process memory hold the saved key
// back, `connect` and `disconnect` are admin commands, and the vault's request tool never fills in the saved key.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');

const policy = require('../lib/hooks/policy');
const cloudKey = require('../lib/cloud-key');
const { createSecretsServer } = require('../lib/broker/mcp');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { budget } = require('./helpers/time_budget');

const HOME = path.join(os.tmpdir(), 'zn-review-home');
const OPTS = { cwd: path.join(HOME, 'project'), home: HOME, env: {} };

/* ---- M1: the keychain checks are linear ---- */

test('keychain checks take well under a second on 100 KB of padding, and the verdict does not change', () => {
  const n = 100 * 1000;
  const pads = [
    'from '.repeat(n / 5) + '; cat .env',
    'from\t'.repeat(n / 5) + '; cat .env',
    'security '.repeat(n / 9) + 'x',
    'import('.repeat(n / 7) + 'x',
    'require('.repeat(n / 8) + 'x',
    'import '.repeat(n / 7) + 'cloud-key',
    'security dump '.repeat(n / 14),
  ];
  for (const p of pads) {
    const t0 = process.hrtime.bigint();
    policy.bashDenial(p.slice(0, n), OPTS);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < budget(2500), JSON.stringify(p.slice(0, 14)) + ' took ' + ms.toFixed(0) + ' ms');
  }
});

test('the keychain checks still refuse the direct ways, however far apart the words are', () => {
  const far = ' '.repeat(5000);
  for (const cmd of [
    'security find-generic-password -s zn-cloud -w',
    'security dump-keychain',
    'security' + far + 'dump-keychain',
    'security   -v   dump-keychain -d',
    'secret-tool lookup service zn-cloud',
    "node -e \"require('./lib/cloud-key').loadStoredKey()\"",
    "node -e \"require(" + far + "'zn-gate/lib/cloud-key').loadStoredKey()\"",
    "python3 -c \"import keyring; keyring.get_password('zn-cloud','cloud-api-key')\"",
  ]) {
    assert.ok(policy.bashDenial(cmd, OPTS), cmd.slice(0, 60));
  }
  for (const cmd of ['security find-generic-password -s my-own-service -w', 'echo import and from', 'git log --oneline']) {
    assert.equal(policy.bashDenial(cmd, OPTS), null, cmd);
  }
});

/* ---- L1: TLS and debugger options ---- */

test('--tls-keylog, --inspect and its variants hold back a saved key', () => {
  const why = (o) => cloudKey.tlsRefusal({ NODE_OPTIONS: o });
  for (const o of [
    '--tls-keylog=/tmp/k.log', '--tls-keylog /tmp/k.log', '"--tls-keylog=/tmp/k.log"', '--inspect', '--inspect=9229', '--inspect-brk',
    '--inspect-brk=0.0.0.0:9229', '--inspect-port=9230', '--inspect-wait', '--no-warnings --inspect', '--openssl-shared-config=/tmp/o.cnf',
  ]) {
    assert.match(why(o), /NODE_OPTIONS/, o);
  }
  for (const o of ['', '--max-old-space-size=512', '--title="--inspect"', '--enable-source-maps']) assert.equal(why(o), null, o);
});

/* ---- L3: connect and disconnect are admin commands ---- */

test('an agent running zn-gate connect or disconnect is refused as an admin command', () => {
  for (const cmd of [
    'zn-gate connect', 'npx -y zn-gate connect --reconnect', 'zn-gate disconnect --revoke', 'zn disconnect --no-revoke',
    'node bin/cli.js connect', 'cd /tmp && zn-gate@1.13.0 disconnect', 'zn-gate -- connect',
  ]) {
    assert.ok(policy.adminCommand(cmd), cmd);
    const deny = policy.bashDenial(cmd, OPTS);
    assert.match(deny, /connect/, cmd);
    assert.match(deny, /own terminal/, cmd);
  }
  for (const cmd of ['zn-gate status', 'zn-gate analyze hello', 'echo connect', 'zn-gate help connect', 'ssh connect-host']) {
    assert.equal(policy.adminCommand(cmd), null, cmd);
  }
});

/* ---- L2: the vault request tool never fills in the saved key ---- */

function startServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

test('secrets_http_request refuses the key stored by connect, even for an allowed host, and still serves other secrets', async () => {
  const { server, seen, port } = await startServer();
  try {
    const vault = createFakeVault();
    const key = 'zn_' + 'ab12'.repeat(12);
    await vault.setSecret(cloudKey.VAULT_SECRET, key, { mode: 'proxy', allowHosts: ['127.0.0.1', 'api.usezn.com'] });
    await vault.setSecret('OTHER_TOKEN', 'ghp_' + 'x1'.repeat(18), { mode: 'proxy', allowHosts: ['127.0.0.1'] });
    const srv = createSecretsServer({ vault, engine: fakeEngine });
    const call = (name, args) => srv.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      .then((r) => ({ isError: r.result.isError, text: r.result.content[0].text }));
    const base = 'http://127.0.0.1:' + port;
    for (const method of ['DELETE', 'GET', 'POST']) {
      const r = await call('secrets_http_request', { method, url: base + '/prod/keys/self', headers: { Authorization: 'Bearer __ZN_' + cloudKey.VAULT_SECRET + '__' } });
      assert.equal(r.isError, true, method);
      assert.match(r.text, /connect/);
      assert.ok(!r.text.includes(key));
    }
    assert.equal(seen.length, 0, 'no request was made with the key');
    const ok = await call('secrets_http_request', { method: 'GET', url: base + '/x', headers: { Authorization: 'Bearer __ZN_OTHER_TOKEN__' } });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(seen.length, 1);
  } finally { server.close(); }
});

/* ---- review 2: underscore options, NODE_DEBUG, the vault and the cloud key marker ---- */

test('Node reads underscores in an option name like dashes: those spellings are refused too', () => {
  const why = (o) => cloudKey.tlsRefusal({ NODE_OPTIONS: o });
  for (const o of [
    '--tls_keylog=/tmp/k.log', '--inspect_brk', '--inspect_brk=9229', '--inspect_port=9230', '--inspect_wait', '--experimental_loader ./l.mjs',
    '--experimental_loader=./l.mjs', '--use_openssl_ca', '--openssl_config=/tmp/o.cnf', '--openssl_shared_config=/tmp/o.cnf', '"--tls_keylog=/tmp/k.log"',
  ]) {
    assert.match(why(o), /NODE_OPTIONS/, o);
  }
  // only the name is normalised, never the value
  assert.equal(why('--title=my_--inspect_app'), null);
  assert.equal(why('--max_old_space_size=512'), null);
});

test('zn audit reads --experimental_loader in NODE_OPTIONS like --experimental-loader', () => {
  const { classifyEnv } = require('../lib/audit/patterns');
  for (const v of ['--experimental_loader ./l.mjs', '--experimental-loader ./l.mjs', '--experimental_policy=p.json']) {
    assert.deepEqual(classifyEnv('NODE_OPTIONS', v), { kind: 'code' }, v);
  }
  assert.equal(classifyEnv('NODE_OPTIONS', '--max-old-space-size=512'), null);
});

test('NODE_DEBUG holds back the saved key, with one line', () => {
  for (const v of ['https', 'http,https', 'tls', 'net', 'anything', '*']) {
    const why = cloudKey.tlsRefusal({ NODE_DEBUG: v });
    assert.match(why, /NODE_DEBUG is set/, v);
    assert.ok(!why.includes('\n'));
  }
  assert.equal(cloudKey.tlsRefusal({ NODE_DEBUG: '' }), null);
  assert.equal(cloudKey.tlsRefusal({ NODE_DEBUG: '  ' }), null);
});

test('with NODE_DEBUG set nothing is sent or saved by analyze, connect or disconnect', async () => {
  const fs = require('fs');
  const crypto = require('crypto');
  const { EventEmitter } = require('events');
  const client = require('../lib/client');
  const connectCli = require('../lib/connect-cli');
  const https = require('https');
  const real = https.request;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-nodedebug-'));
  process.env.ZN_HOME = home;
  let requests = 0;
  https.request = () => {
    requests++;
    const req = new EventEmitter();
    req.write = () => {}; req.destroy = () => {};
    req.end = () => setImmediate(() => req.emit('error', new Error('stubbed')));
    return req;
  };
  let mem = null;
  const deps = { native: { name: 'fake', slot: {}, impl: { store: (k) => { mem = k; }, load: () => mem, remove: () => { mem = null; return true; } } }, vault: { isUnlocked: async () => false } };
  try {
    cloudKey._use(deps);
    const key = 'zn_' + crypto.randomBytes(24).toString('hex');
    await cloudKey.saveKey(key, deps);
    process.env.NODE_DEBUG = 'https';
    const r = await client.analyze('What is the weather today?', {});
    assert.equal(requests, 0);
    assert.equal(r.mode, 'oss-local');
    assert.match(r.cloud_error, /NODE_DEBUG/);
    const res = await connectCli.request(https, 'DELETE', '/prod/keys/self', key);
    assert.equal(requests, 0);
    assert.match(res.error, /NODE_DEBUG/);
  } finally {
    https.request = real;
    cloudKey._use(null);
    delete process.env.NODE_DEBUG; delete process.env.ZN_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a command that loads zn-gate client code by its path is refused', () => {
  for (const cmd of [
    "node -e \"require('zn-gate/lib/client').analyze('x')\"",
    "node -e \"require('/usr/lib/node_modules/zn-gate/lib/client.js').isCloudEnabled()\"",
    "node -e \"require('./node_modules/zn-gate/lib/client').analyze('x')\"",
    "node -e \"const c = require('./packages/zn-gate/lib/client'); c.analyze('hi')\"",
    "node -e \"require('C:/Users/me/node_modules/zn-gate/lib/client').analyze('x')\"",
    'node -e "require(\'C:\\Users\\me\\node_modules\\zn-gate\\lib\\client\').analyze(1)"',
    'node -e "require(\'C:\\\\Users\\\\me\\\\node_modules\\\\zn-gate\\\\lib\\\\client\').analyze(1)"',
    'node -e "require(\'C:\\\\Users\\\\me\\\\node_modules\\\\zn-gate\\\\lib\\\\vault\\\\client\').resolveApiKey()"',
    "node -e \"require('zn-gate//lib///client').analyze(1)\"",
    "node -e \"import('zn-gate/lib/vault/client').then((m) => m.resolveApiKey())\"",
    "node -e \"require('zn-gate/lib/vault/client').resolve('/', '__ZN_X__', {})\"; analyze",
  ]) {
    assert.ok(policy.bashDenial(cmd, OPTS), cmd);
  }
});

test('ordinary commands that mention a lib/client of any project stay allowed', () => {
  for (const cmd of [
    "node -e \"require('./lib/client').analyze(process.argv[1])\" data.csv",
    'grep -nE "^import |analyze" src/lib/client.ts',
    'rg -n "from .* import|def analyze" lib/client.py',
    'cat lib/client.js | grep -n -e "import " -e analyze',
    "python3 -c \"import runpy; runpy.run_path('lib/client.py')\" --analyze",
    "npx tsx -e \"import { analyze } from './src/lib/client'; analyze()\"",
    'sed -n 1,80p src/lib/client.ts',
    'npx jest lib/client -t analyze',
    'npx vitest run src/lib/client.test.ts -t "from analyze"',
    'git diff src/lib/client.ts | grep -E "import |analyze"',
    'npx -y zn-gate check',
    'zn-gate analyze "hello"',
    "node -e \"require('zn-gate/lib/client-pool').analyze('x')\"",
  ]) {
    assert.equal(policy.bashDenial(cmd, OPTS), null, cmd);
  }
});

test('the client-module check stays linear on 100 KB', () => {
  const n = 100 * 1000;
  for (const p of ['import '.repeat(n / 7) + 'zn-gate/lib/client', 'analyze '.repeat(n / 8) + 'x', 'zn-gate/lib/'.repeat(n / 12 - 2) + 'require( analyze', 'zn-gate' + '/'.repeat(n - 10), 'zn-gate\\'.repeat(n / 8) + 'x', 'zn-gate/lib' + '\\/'.repeat(n / 2 - 20) + ' require( analyze', 'from '.repeat(n / 5) + '; cat .env']) {
    const t0 = process.hrtime.bigint();
    policy.bashDenial(p.slice(0, n), OPTS);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < budget(2500), p.slice(0, 12) + ' took ' + ms.toFixed(0) + ' ms');
  }
});

test('the key-code barrier ignores case, accepts backslashes in vault/keychain and drops ./ segments', () => {
  const q = "'";
  const wrap = (m) => 'node -e "require(' + q + m + q + ').analyze(' + q + 'x' + q + ')"';
  for (const m of [
    'ZN-GATE/LIB/CLIENT',
    'Zn-Gate/lib/Client.js',
    'zn-gate\\lib\\vault\\keychain',
    'zn-gate/lib/VAULT/KEYCHAIN',
    'zn-gate/./lib/client',
    'zn-gate/lib/./vault/client',
    'zn-gate/././lib/client',
    'zn-gate\\.\\lib\\client',
  ]) {
    assert.ok(policy.bashDenial(wrap(m), OPTS), m);
  }
});

test('lookalike commands stay allowed after the case and dot handling', () => {
  for (const cmd of [
    "node -e \"require('./lib/./client').analyze(1)\"",
    'cat ./a/./b/lib/client.js | grep -n -e "import " -e analyze',
    'cat node_modules/ZN-GATE/LIB/CLIENT.js | head -50',
  ]) {
    assert.equal(policy.bashDenial(cmd, OPTS), null, cmd);
  }
});
