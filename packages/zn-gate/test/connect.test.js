'use strict';

// zn-gate connect / disconnect, the stored key, and how the cloud check finds it.
// Everything runs against fakes: keys are generated at run time, the keychain and
// the vault are in memory, the HTTPS module is a stub that records the request.
// No real keychain is touched and nothing talks to the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

const cloudKey = require('../lib/cloud-key');
const connectCli = require('../lib/connect-cli');
const client = require('../lib/client');

const BIN = path.join(__dirname, '..', 'bin', 'cli.js');
const freshKey = () => 'zn_' + crypto.randomBytes(24).toString('hex');

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-connect-'));
  process.env.ZN_HOME = dir;
  return dir;
}

function cleanup(dir) {
  cloudKey._use(null);
  delete process.env.ZN_HOME;
  delete process.env.ZN_CLOUD;
  delete process.env.ZN_API_KEY;
  delete process.env.ZN_LOCAL_ONLY;
  fs.rmSync(dir, { recursive: true, force: true });
}

function allFileText(dir) {
  let text = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    text += e.isDirectory() ? allFileText(p) : fs.readFileSync(p, 'utf8');
  }
  return text;
}

/* ---------------------------- fakes ---------------------------- */

function fakeKeychain() {
  const map = new Map();
  const slot = { service: 'zn-cloud', account: 'cloud-api-key' };
  const id = (s) => s.service + ':' + s.account;
  return {
    map,
    native: {
      name: 'fake',
      slot,
      impl: {
        store(v, s) { map.set(id(s), v); },
        load(s) { return map.has(id(s)) ? map.get(id(s)) : null; },
        remove(s) { return map.delete(id(s)); },
      },
    },
    vault: { isUnlocked: async () => false },
  };
}

function fakeVault({ unlocked = true } = {}) {
  const secrets = new Map();
  const calls = [];
  return {
    secrets,
    calls,
    isUnlocked: async () => unlocked,
    async setSecret(name, value, meta) { if (!unlocked) throw new Error('locked'); calls.push(['set', name, meta]); secrets.set(name, value); return true; },
    async resolve(project, token) { if (!unlocked) throw new Error('locked'); const m = /^__ZN_(.+)__$/.exec(token); return secrets.has(m[1]) ? secrets.get(m[1]) : null; },
    async removeSecret(name) { if (!unlocked) { const e = new Error('locked'); e.code = 'ZN_LOCKED'; throw e; } secrets.delete(name); return true; },
  };
}

function fakeTty({ confirms = [true], key, human = true } = {}) {
  const calls = { confirm: [], hidden: [], human: 0 };
  return {
    calls,
    requireHuman(what) {
      calls.human++;
      if (!human) { const e = new Error(what + ' needs an interactive terminal.'); e.code = 'ZN_POLICY_DENIED'; throw e; }
    },
    async confirm(q) { calls.confirm.push(q); return confirms.length ? confirms.shift() : false; },
    async readHidden(p) {
      calls.hidden.push(p);
      if (key === undefined) throw new Error('cancelled');
      return key;
    },
  };
}

/* An https module that records every request and answers from a script. */
function fakeHttps(...answers) {
  const calls = [];
  return {
    calls,
    request(opts, cb) {
      calls.push(opts);
      const ans = answers.length > 1 ? answers.shift() : answers[0];
      const req = new EventEmitter();
      req.destroy = () => {};
      req.write = () => {};
      req.end = () => setImmediate(() => {
        if (ans.error) { req.emit('error', Object.assign(new Error(ans.error), { code: ans.error })); return; }
        const res = new EventEmitter();
        res.statusCode = ans.status;
        res.setEncoding = () => {};
        cb(res);
        res.emit('data', ans.body || '');
        res.emit('end');
      });
      return req;
    },
  };
}

function harness(over = {}) {
  const out = [];
  const err = [];
  const kc = over.deps || fakeKeychain();
  const t = over.tty || fakeTty({ key: over.key });
  const h = over.https || fakeHttps({ status: 403, body: JSON.stringify({ error: 'key_scope', message: 'This key can only analyze prompts.' }) });
  const opened = [];
  return {
    out, err, kc, t, h, opened,
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      tty: t,
      https: h,
      deps: kc,
      openBrowser: (u) => { opened.push(u); return over.browserWorks !== false; },
    },
    text() { return out.join('') + err.join(''); },
  };
}

/* ---------------------------- connect: gates ---------------------------- */

test('connect refuses without a real terminal and stores nothing', async () => {
  const home = tmpHome();
  try {
    const out = []; const err = [];
    const rc = await connectCli.connect([], {
      out: (s) => out.push(s), err: (s) => err.push(s),
      ttyIo: { stdin: { isTTY: false }, env: {}, ancestry: () => null },
      deps: fakeKeychain(), https: fakeHttps({ status: 200, body: '{}' }),
    });
    assert.equal(rc, 1);
    assert.match(err.join(''), /needs an interactive terminal/);
    assert.deepEqual(fs.readdirSync(home), []);
  } finally { cleanup(home); }
});

test('connect refuses when an AI agent is among the parent processes', async () => {
  const home = tmpHome();
  try {
    const err = [];
    const rc = await connectCli.connect([], {
      out: () => {}, err: (s) => err.push(s),
      ttyIo: { stdin: { isTTY: true }, env: {}, ancestry: () => 'claude' },
      deps: fakeKeychain(), https: fakeHttps({ status: 200, body: '{}' }),
    });
    assert.equal(rc, 1);
    assert.match(err.join(''), /not by an AI agent/);
    assert.equal(cloudKey.readMarker(), null);
  } finally { cleanup(home); }
});

test('the key is never accepted as an argument', async () => {
  const home = tmpHome();
  try {
    const key = freshKey();
    for (const args of [[key], ['--key', key], ['--api-key=' + key], ['--token', key]]) {
      const h = harness({ key });
      const rc = await connectCli.connect(args, h.io);
      assert.equal(rc, 2, args.join(' '));
      assert.ok(!h.text().includes(key), 'the key was echoed');
      assert.match(h.err.join(''), /Never put the key on the command line/);
      assert.equal(h.t.calls.hidden.length, 0);
      assert.equal(h.h.calls.length, 0);
    }
    const h = harness();
    assert.equal(await connectCli.connect(['--bogus'], h.io), 2);
    assert.match(h.err.join(''), /Usage: zn-gate connect/);
  } finally { cleanup(home); }
});

test('saying no at the first question changes nothing and opens nothing', async () => {
  const home = tmpHome();
  try {
    const h = harness({ tty: fakeTty({ confirms: [false], key: freshKey() }) });
    assert.equal(await connectCli.connect([], h.io), 1);
    assert.equal(h.opened.length, 0);
    assert.equal(h.t.calls.hidden.length, 0);
    assert.equal(h.h.calls.length, 0);
    assert.equal(h.kc.map.size, 0);
    assert.match(h.text(), /stays fully local/);
  } finally { cleanup(home); }
});

/* ---------------------------- connect: stores ---------------------------- */

test('connect stores the key in the keychain, verifies it against the fixed host, and keeps it out of every file and output', async () => {
  const home = tmpHome();
  try {
    const key = freshKey();
    const h = harness({ key });
    assert.equal(await connectCli.connect([], h.io), 0);
    // the key is in the keychain slot and nowhere else
    assert.equal(h.kc.map.get('zn-cloud:cloud-api-key'), key);
    assert.ok(!allFileText(home).includes(key), 'a file under ZN_HOME holds the key');
    const marker = cloudKey.readMarker();
    assert.equal(marker.store, 'keychain');
    assert.equal(marker.last4, key.slice(-4));
    assert.ok(!fs.existsSync(path.join(home, 'cloud.json')));
    // output: last four only
    assert.ok(!h.text().includes(key));
    assert.match(h.out.join(''), new RegExp('Key: \\.\\.\\.' + key.slice(-4)));
    assert.match(h.out.join(''), /Cloud check is ON for analyze_prompt/);
    assert.match(h.out.join(''), /Key scope: analyze only/);
    // the browser got the agreed URL
    assert.deepEqual(h.opened, ['https://usezn.com/connect?source=cli&utm_source=cli']);
    // hidden prompt, own terminal
    assert.equal(h.t.calls.hidden.length, 1);
    assert.match(h.t.calls.hidden[0], /hidden/);
    // exactly one request: GET to the fixed host over TLS, key only in the Authorization header
    assert.equal(h.h.calls.length, 1);
    const req = h.h.calls[0];
    assert.equal(req.hostname, 'api.usezn.com');
    assert.equal(req.port, 443);
    assert.equal(req.method, 'GET');
    assert.equal(req.path, connectCli.VERIFY_PATH);
    assert.equal(req.rejectUnauthorized, true);
    assert.equal(req.headers.Authorization, 'Bearer ' + key);
    assert.ok(!req.path.includes(key));
    assert.equal(Object.keys(req).includes('host'), false);
  } finally { cleanup(home); }
});

test('connect with the browser unavailable prints the address', async () => {
  const home = tmpHome();
  try {
    const h = harness({ key: freshKey(), browserWorks: false });
    assert.equal(await connectCli.connect([], h.io), 0);
    assert.match(h.out.join(''), /Open this address yourself:\n  https:\/\/usezn\.com\/connect\?source=cli&utm_source=cli/);
  } finally { cleanup(home); }
});

test('a full-access key (the server answers 200) is refused, not stored, with the way to get an analysis-only one', async () => {
  const home = tmpHome();
  try {
    const key = freshKey();
    const h = harness({ key, https: fakeHttps({ status: 200, body: JSON.stringify({ plan: 'free' }) }) });
    assert.equal(await connectCli.connect([], h.io), 1);
    assert.equal(h.kc.map.size, 0);
    assert.equal(cloudKey.readMarker(), null);
    assert.match(h.err.join(''), /only accepts a key limited to analyzing/);
    assert.match(h.err.join(''), /https:\/\/usezn\.com\/connect\?source=cli&utm_source=cli/);
    assert.ok(!h.text().includes(key));
    assert.equal(client.isCloudEnabled(), false);
  } finally { cleanup(home); }
});

test('a 403 that is not key_scope does not count as an analysis-only key', async () => {
  const home = tmpHome();
  try {
    for (const body of ['{"error":"email_not_verified"}', 'not json', '']) {
      const h = harness({ key: freshKey(), https: fakeHttps({ status: 403, body }) });
      assert.equal(await connectCli.connect([], h.io), 1, body);
      assert.equal(h.kc.map.size, 0);
      assert.match(h.err.join(''), /Could not verify the key.*HTTP 403.*nothing was saved/);
    }
  } finally { cleanup(home); }
});

test('a rejected key (HTTP 401) is not saved', async () => {
  const home = tmpHome();
  try {
    const key = freshKey();
    const h = harness({ key, https: fakeHttps({ status: 401, body: '{"error":"Unauthorized"}' }) });
    assert.equal(await connectCli.connect([], h.io), 1);
    assert.equal(h.kc.map.size, 0);
    assert.equal(cloudKey.readMarker(), null);
    assert.match(h.err.join(''), /did not accept this key/);
    assert.ok(!h.text().includes(key));
  } finally { cleanup(home); }
});

test('when the check cannot run (network error, HTTP 503) nothing is stored', async () => {
  for (const ans of [{ error: 'ENOTFOUND' }, { status: 503, body: '' }, { status: 429, body: '{}' }]) {
    const home = tmpHome();
    try {
      const key = freshKey();
      const h = harness({ key, https: fakeHttps(ans) });
      assert.equal(await connectCli.connect([], h.io), 1);
      assert.match(h.err.join(''), /Could not verify the key with usezn\.com \(.+\), so nothing was saved/);
      assert.equal(h.kc.map.size, 0);
      assert.equal(cloudKey.readMarker(), null);
      assert.ok(!h.text().includes(key));
    } finally { cleanup(home); }
  }
});

test('values that are not a zn key are refused before any network call', async () => {
  const home = tmpHome();
  try {
    for (const bad of ['', 'short', '${user_config.api_key}', '%ZN_API_KEY%', 'sk_' + 'a'.repeat(40), 'zn_', 'zn_ with space ' + 'a'.repeat(30)]) {
      const h = harness({ key: bad });
      assert.equal(await connectCli.connect([], h.io), 1, JSON.stringify(bad));
      assert.match(h.err.join(''), /does not look like a zn API key/);
      assert.equal(h.h.calls.length, 0);
      assert.equal(h.kc.map.size, 0);
    }
  } finally { cleanup(home); }
});

test('an empty or cancelled prompt saves nothing', async () => {
  const home = tmpHome();
  try {
    const h = harness({ tty: fakeTty({ key: undefined }) });
    assert.equal(await connectCli.connect([], h.io), 1);
    assert.match(h.err.join(''), /Cancelled/);
    assert.equal(h.kc.map.size, 0);
  } finally { cleanup(home); }
});

test('without a keychain or an unlocked vault nothing is stored, ZN_API_KEY is explained and no key is asked for', async () => {
  const home = tmpHome();
  try {
    const key = freshKey();
    const deps = { native: null, vault: fakeVault({ unlocked: false }) };
    const h = harness({ key, deps });
    assert.equal(await connectCli.connect([], h.io), 1);
    assert.match(h.out.join(''), /will not keep the key in a plain file/);
    assert.match(h.out.join(''), /ZN_API_KEY=<your key> and ZN_CLOUD=1/);
    assert.equal(h.t.calls.hidden.length, 0, 'asked for a key it cannot keep');
    assert.equal(h.h.calls.length, 0);
    assert.equal(h.opened.length, 0);
    assert.deepEqual(fs.readdirSync(home), []);
  } finally { cleanup(home); }
});

test('without a keychain the unlocked vault holds the key, for api.usezn.com only', async () => {
  const home = tmpHome();
  try {
    const key = freshKey();
    const vault = fakeVault();
    const h = harness({ key, deps: { native: null, vault } });
    assert.equal(await connectCli.connect([], h.io), 0);
    assert.equal(vault.secrets.get('ZN_CLOUD_API_KEY'), key);
    assert.deepEqual(vault.calls[0][2].allowHosts, ['api.usezn.com']);
    assert.equal(cloudKey.readMarker().store, 'vault');
    assert.ok(!allFileText(home).includes(key));
    assert.match(h.out.join(''), /Saved in the zn vault/);
    const found = await cloudKey.resolveApiKey({}, { native: null, vault });
    assert.deepEqual(found, { key, source: 'vault' });
  } finally { cleanup(home); }
});

test('a keychain that does not return what was stored fails and leaves nothing behind', async () => {
  const home = tmpHome();
  try {
    const key = freshKey();
    const deps = fakeKeychain();
    deps.native.impl.store = () => {}; // silently drops the item
    const h = harness({ key, deps });
    assert.equal(await connectCli.connect([], h.io), 1);
    assert.match(h.err.join(''), /Could not save the key/);
    assert.equal(cloudKey.readMarker(), null);
    assert.ok(!h.text().includes(key));
  } finally { cleanup(home); }
});

test('already connected: a second run shows the state and neither prompts nor duplicates; --reconnect replaces', async () => {
  const home = tmpHome();
  try {
    const first = freshKey();
    const h1 = harness({ key: first });
    assert.equal(await connectCli.connect([], h1.io), 0);
    const h2 = harness({ key: freshKey(), deps: h1.kc });
    assert.equal(await connectCli.connect([], h2.io), 0);
    assert.match(h2.out.join(''), new RegExp('Already connected: key \\.\\.\\.' + first.slice(-4) + ' is in your system keychain'));
    assert.equal(h2.t.calls.hidden.length, 0);
    assert.equal(h1.kc.map.size, 1);
    const second = freshKey();
    const h3 = harness({ key: second, deps: h1.kc });
    assert.equal(await connectCli.connect(['--reconnect'], h3.io), 0);
    assert.equal(h1.kc.map.size, 1);
    assert.equal(h1.kc.map.get('zn-cloud:cloud-api-key'), second);
    assert.equal(cloudKey.readMarker().last4, second.slice(-4));
  } finally { cleanup(home); }
});

test('the marker keeps the other settings in config.json', async () => {
  const home = tmpHome();
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ stats: { share: false }, mcpPinning: 'block' }));
    const h = harness({ key: freshKey() });
    assert.equal(await connectCli.connect([], h.io), 0);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(cfg.mcpPinning, 'block');
    assert.deepEqual(cfg.stats, { share: false });
    assert.equal(cfg.cloud.store, 'keychain');
    assert.deepEqual(Object.keys(cfg.cloud).sort(), ['connectedAt', 'last4', 'store']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, 'config.json')).mode & 0o777, 0o600);
  } finally { cleanup(home); }
});

/* ---------------------------- disconnect ---------------------------- */

async function connected(extra = {}) {
  const key = freshKey();
  const h = harness({ key, ...extra });
  assert.equal(await connectCli.connect([], h.io), 0);
  return { key, kc: h.kc };
}

test('disconnect, answered no, removes the local copy and the marker, makes no network call and says how to revoke the key', async () => {
  const home = tmpHome();
  try {
    const { key, kc } = await connected();
    const h = harness({ deps: kc, tty: fakeTty({ confirms: [false] }), https: fakeHttps({ status: 204, body: '' }) });
    assert.equal(await connectCli.disconnect([], h.io), 0);
    assert.equal(kc.map.size, 0);
    assert.equal(cloudKey.readMarker(), null);
    assert.equal(h.h.calls.length, 0, 'nothing is sent without an explicit yes');
    assert.equal(h.t.calls.confirm.length, 1, 'the revoke is offered once');
    assert.match(h.out.join(''), /still works until you revoke it\. Revoke it at https:\/\/usezn\.com\/api-keys/);
    assert.ok(!h.text().includes(key));
    assert.equal(client.isCloudEnabled(), false);
  } finally { cleanup(home); }
});

test('disconnect when not connected is a no-op; extra arguments and no terminal are refused', async () => {
  const home = tmpHome();
  try {
    const h = harness({ tty: fakeTty({ confirms: [] }) });
    assert.equal(await connectCli.disconnect([], h.io), 0);
    assert.match(h.out.join(''), /Not connected/);
    assert.equal(await connectCli.disconnect(['--yes'], h.io), 2);
    const h2 = harness({ tty: fakeTty({ human: false }) });
    assert.equal(await connectCli.disconnect([], h2.io), 1);
  } finally { cleanup(home); }
});

test('vault locked at disconnect: the marker stays so a second try works', async () => {
  const home = tmpHome();
  try {
    const key = freshKey();
    const vault = fakeVault();
    const h = harness({ key, deps: { native: null, vault } });
    assert.equal(await connectCli.connect([], h.io), 0);
    const locked = { native: null, vault: fakeVault({ unlocked: false }) };
    const d = harness({ deps: locked, tty: fakeTty({ confirms: [] }) });
    assert.equal(await connectCli.disconnect([], d.io), 1);
    assert.match(d.err.join(''), /Run `(zn|npx -y zn-gate@[\d.]+) unlock` and try again/);
    assert.ok(cloudKey.readMarker());
    const again = harness({ deps: { native: null, vault }, tty: fakeTty({ confirms: [false] }) });
    assert.equal(await connectCli.disconnect([], again.io), 0);
    assert.equal(cloudKey.readMarker(), null);
    assert.equal(vault.secrets.size, 0);
  } finally { cleanup(home); }
});

/* ---------------------------- how the cloud check finds the key ---------------------------- */

test('isCloudEnabled: a key alone enables nothing; ZN_CLOUD=1 with a key, or connect, does; local-only wins', async () => {
  const home = tmpHome();
  try {
    const key = freshKey();
    assert.equal(client.isCloudEnabled({ apiKey: key }), false);
    process.env.ZN_API_KEY = key;
    assert.equal(client.isCloudEnabled({}), false);
    process.env.ZN_CLOUD = '1';
    assert.equal(client.isCloudEnabled({}), true);
    assert.equal(client.isCloudEnabled({ localOnly: true }), false);
    delete process.env.ZN_API_KEY; delete process.env.ZN_CLOUD;
    assert.equal(client.isCloudEnabled({}), false);
    cloudKey._use(fakeKeychain());
    const h = harness({ key, deps: fakeKeychain() });
    assert.equal(await connectCli.connect([], h.io), 0);
    assert.equal(client.isCloudEnabled({}), true, 'connected');
    assert.equal(client.isCloudEnabled({ localOnly: true }), false);
    process.env.ZN_LOCAL_ONLY = 'true';
    assert.equal(client.isCloudEnabled({}), false);
  } finally { cleanup(home); }
});

test('the key from --key or the environment beats the stored one', async () => {
  const home = tmpHome();
  try {
    const stored = freshKey();
    const deps = fakeKeychain();
    const h = harness({ key: stored, deps });
    assert.equal(await connectCli.connect([], h.io), 0);
    assert.deepEqual(await cloudKey.resolveApiKey({}, deps), { key: stored, source: 'keychain' });
    const flag = freshKey();
    assert.deepEqual(await cloudKey.resolveApiKey({ apiKey: flag }, deps), { key: flag, source: 'flag' });
    const env = freshKey();
    process.env.ZN_API_KEY = env;
    assert.deepEqual(await cloudKey.resolveApiKey({ apiKey: env }, deps), { key: env, source: 'environment' });
  } finally { cleanup(home); }
});

test('analyze() sends the stored key to the gateway only after connect, and falls back when the key cannot be read', async () => {
  const home = tmpHome();
  const https = require('https');
  const realRequest = https.request;
  try {
    const key = freshKey();
    const deps = fakeKeychain();
    const h = harness({ key, deps });
    assert.equal(await connectCli.connect([], h.io), 0);
    cloudKey._use(deps);
    const seen = [];
    https.request = (url, opts, cb) => {
      seen.push({ host: new URL(url).hostname, auth: opts.headers.Authorization });
      return fakeHttps({ status: 200, body: JSON.stringify({ verdict: 'allow', confidence: 0.1, rule: 'none' }) }).request(opts, cb);
    };
    const r = await client.analyze('What is the weather in Madrid today?', {});
    assert.equal(r.mode, 'hybrid-cloud');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].host, 'api.usezn.com');
    assert.equal(seen[0].auth, 'Bearer ' + key);
    // the keychain lost the key: local rules, no request
    deps.map.clear();
    seen.length = 0;
    const r2 = await client.analyze('What is the weather in Madrid today?', {});
    assert.equal(r2.mode, 'oss-local');
    assert.equal(r2.fallback, true);
    assert.equal(seen.length, 0);
    // local-only: no request even with the key present
    deps.map.set('zn-cloud:cloud-api-key', key);
    const r3 = await client.analyze('What is the weather in Madrid today?', { localOnly: true });
    assert.equal(r3.mode, 'oss-local');
    assert.equal(seen.length, 0);
  } finally { https.request = realRequest; cleanup(home); }
});

/* ---------------------------- not in the hook path; status ---------------------------- */

test('no hook, shield or scrubber module reads the stored key or the cloud settings', () => {
  const lib = path.join(__dirname, '..', 'lib');
  const files = [];
  for (const dir of ['hooks', 'scrub']) for (const f of fs.readdirSync(path.join(lib, dir))) files.push(path.join(lib, dir, f));
  files.push(path.join(lib, 'shield.js'), path.join(lib, 'evidence.js'));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /require\(\s*['"][^'"]*(?:cloud-key|connect-cli)|cloudKey/, path.relative(lib, f));
  }
});

test('connect-cli talks to one host only and has no other URL', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'connect-cli.js'), 'utf8');
  const hosts = new Set((src.match(/https?:\/\/[A-Za-z0-9.-]+/g) || []));
  assert.deepEqual([...hosts].sort(), ['https://api.usezn.com', 'https://usezn.com']);
  assert.equal((src.match(/hostname:/g) || []).length, 1);
  assert.match(src, /API_HOST = 'api\.usezn\.com'/);
});

function status(env) {
  const r = spawnSync(process.execPath, [BIN, 'status'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ZN_KEYCHAIN_BACKEND: 'passphrase', ...env }, encoding: 'utf8' });
  return r.stdout;
}

test('status: unchanged without a key, shows the origin of an environment key, and never shows the key', () => {
  const home = tmpHome();
  try {
    const none = status({ ZN_HOME: home });
    assert.match(none, /API key {9}: Not set/);
    assert.doesNotMatch(none, /Connected/);
    const key = freshKey();
    const envOnly = status({ ZN_HOME: home, ZN_API_KEY: key });
    assert.match(envOnly, /API key {9}: Set \(ZN_API_KEY\) \(unused: cloud requires ZN_CLOUD=1\)/);
    assert.ok(!envOnly.includes(key));
    const both = status({ ZN_HOME: home, ZN_API_KEY: key, ZN_CLOUD: '1' });
    assert.match(both, /Local rules \+ cloud/);
    assert.ok(!both.includes(key));
  } finally { cleanup(home); }
});

test('status: a connected marker shows the last four and warns when the key is gone', () => {
  const home = tmpHome();
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ cloud: { store: 'keychain', connectedAt: '2026-10-17T10:00:00.000Z', last4: 'ab12' } }));
    const out = status({ ZN_HOME: home });
    assert.match(out, /Connected {7}: yes, key \.\.\.ab12 \(not found in your system keychain/);
    assert.match(out, /zn-gate disconnect/);
    assert.match(out, /API key {9}: Not set/);
  } finally { cleanup(home); }
});
