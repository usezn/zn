'use strict';

// zn-gate connect / disconnect: argument parsing, usage text, the "nothing connected" path and
// error messages that need no network. Temp dirs and a temp HOME, a stub that fails on any request.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cloudKey = require('../lib/cloud-key');
const connectCli = require('../lib/connect-cli');
const messages = require('../lib/messages');

const SAVED = {};
let dir;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cli-args-'));
  for (const k of ['ZN_HOME', 'HOME', 'USERPROFILE']) SAVED[k] = process.env[k];
  process.env.ZN_HOME = dir;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
});
test.afterEach(() => {
  cloudKey._use(null);
  for (const k of Object.keys(SAVED)) {
    if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function harness({ human = true } = {}) {
  const out = []; const err = []; const requests = [];
  const tty = {
    requireHuman(what) {
      if (!human) { const e = new Error(what + ' needs an interactive terminal.'); e.code = 'ZN_POLICY_DENIED'; throw e; }
    },
    async confirm() { throw new Error('no prompt expected'); },
    async readHidden() { throw new Error('no prompt expected'); },
  };
  const https = { request(opts) { requests.push(opts); throw new Error('no network expected'); } };
  const io = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    tty,
    https,
    openBrowser: () => { throw new Error('no browser expected'); },
  };
  return { io, requests, out: () => out.join(''), err: () => err.join('') };
}

test('connect with an unknown argument prints usage and exits 2', async () => {
  const h = harness();
  const code = await connectCli.connect(['--bogus'], h.io);
  assert.equal(code, 2);
  assert.equal(h.err(), 'Usage: zn-gate connect [--reconnect]\n');
  assert.equal(h.out(), '');
  assert.equal(h.requests.length, 0);
});

test('connect refuses a key given as an argument and does not echo it', async () => {
  const fake = 'zn_' + 'ab'.repeat(24);
  for (const args of [[fake], ['--key', fake], ['--api-key=' + fake], ['--token']]) {
    const h = harness();
    const code = await connectCli.connect(args, h.io);
    assert.equal(code, 2);
    assert.equal(h.err(), messages.CONNECT_KEY_ON_COMMAND_LINE + '\n');
    assert.ok(!h.err().includes(fake));
    assert.equal(h.requests.length, 0);
  }
});

test('connect without a person at the terminal stops with the terminal message', async () => {
  const h = harness({ human: false });
  const code = await connectCli.connect([], h.io);
  assert.equal(code, 1);
  assert.match(h.err(), /zn-gate connect needs an interactive terminal\./);
  assert.equal(h.requests.length, 0);
});

test('disconnect rejects unknown flags and conflicting flags with usage', async () => {
  const usage = 'Usage: zn-gate disconnect [--revoke | --no-revoke]\n';
  for (const args of [['--bogus'], ['--revoke', '--no-revoke'], ['--revoke', 'extra'], ['now']]) {
    const h = harness();
    const code = await connectCli.disconnect(args, h.io);
    assert.equal(code, 2, args.join(' '));
    assert.equal(h.err(), usage);
    assert.equal(h.out(), '');
  }
});

test('disconnect without a person at the terminal removes nothing and points to the dashboard', async () => {
  const h = harness({ human: false });
  const code = await connectCli.disconnect(['--revoke'], h.io);
  assert.equal(code, 1);
  assert.match(h.err(), /zn-gate disconnect needs an interactive terminal\./);
  assert.match(h.err(), /Nothing was removed or revoked\./);
  assert.match(h.err(), /https:\/\/usezn\.com\/api-keys/);
  assert.equal(h.requests.length, 0);
});

test('disconnect when nothing is connected says so, exits 0 and makes no request', async () => {
  for (const args of [[], ['--revoke'], ['--no-revoke']]) {
    const h = harness();
    const code = await connectCli.disconnect(args, h.io);
    assert.equal(code, 0, args.join(' '));
    assert.equal(h.out(), 'Not connected. Nothing to remove.\n');
    assert.equal(h.err(), '');
    assert.equal(h.requests.length, 0);
  }
});

test('request returns an error without a network call when the environment refuses TLS checks', async () => {
  const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const h = harness();
    const r = await connectCli.request(h.io.https, 'GET', connectCli.VERIFY_PATH, 'zn_' + '0'.repeat(48), false);
    assert.ok(r.error, 'an error is returned');
    assert.equal(h.requests.length, 0);
  } finally {
    if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved;
  }
});

test('request reports a connection error with the key removed', async () => {
  const key = 'zn_' + 'cd'.repeat(24);
  const https = {
    request() { throw new Error('refused for ' + key); },
  };
  const r = await connectCli.request(https, 'GET', connectCli.VERIFY_PATH, key, false);
  assert.equal(r.error, 'refused for [key]');
});

test('scrub removes the given key and anything shaped like a key', () => {
  const key = 'zn_' + 'ef'.repeat(24);
  const other = 'zn_' + '12'.repeat(24);
  assert.equal(connectCli.scrub('a ' + key + ' b ' + other, key), 'a [key] b [key]');
  assert.equal(connectCli.scrub(null, null), 'null');
});

test('the API host and routes are fixed', () => {
  assert.equal(connectCli.API_HOST, 'api.usezn.com');
  assert.equal(connectCli.VERIFY_PATH, '/prod/usage');
  assert.equal(connectCli.REVOKE_PATH, '/prod/keys/self');
  assert.match(connectCli.CONNECT_URL, /^https:\/\/usezn\.com\/connect/);
});
