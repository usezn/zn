'use strict';

// zn-gate disconnect --revoke: the optional revoke of the saved key on usezn.com.
// Fake keys, in-memory keychain, stubbed HTTPS: no real keychain and no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const cloudKey = require('../lib/cloud-key');
const connectCli = require('../lib/connect-cli');

const freshKey = () => 'zn_' + crypto.randomBytes(24).toString('hex');

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-revoke-'));
  process.env.ZN_HOME = dir;
  return dir;
}
function cleanup(dir) {
  cloudKey._use(null);
  delete process.env.ZN_HOME;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  fs.rmSync(dir, { recursive: true, force: true });
}

function memKeychain() {
  let mem = null;
  const slot = { service: 'zn-cloud', account: 'cloud-api-key' };
  const impl = { store: (k) => { mem = k; }, load: () => mem, remove: () => { mem = null; return true; } };
  return { deps: { native: { name: 'fake', slot, impl }, vault: { isUnlocked: async () => false } }, get: () => mem };
}

function fakeTty({ confirms = [], human = true } = {}) {
  const calls = { confirm: [] };
  return {
    calls,
    requireHuman(what) {
      if (!human) { const e = new Error(what + ' needs an interactive terminal.'); e.code = 'ZN_POLICY_DENIED'; throw e; }
    },
    async confirm(q) { calls.confirm.push(q); return confirms.length ? confirms.shift() : false; },
  };
}

function fakeHttps(ans) {
  const calls = [];
  return {
    calls,
    request(opts, cb) {
      calls.push(opts);
      const req = new EventEmitter();
      req.destroy = () => {};
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

/** A machine with a connected key; runs disconnect with the given answers and flags. */
async function run({ ans = { status: 200, body: '{"revoked":"x"}' }, confirms = [true], args = [], human = true } = {}) {
  const key = freshKey();
  const kc = memKeychain();
  cloudKey._use(kc.deps);
  await cloudKey.saveKey(key, kc.deps);
  const out = []; const err = [];
  const t = fakeTty({ confirms, human });
  const h = fakeHttps(ans);
  const code = await connectCli.disconnect(args, { out: (s) => out.push(s), err: (s) => err.push(s), tty: t, https: h, deps: kc.deps });
  return { key, kc, t, h, code, out: out.join(''), err: err.join(''), all: out.join('') + err.join('') };
}

const LINK = /https:\/\/usezn\.com\/api-keys/;

function assertClean(r) {
  assert.ok(!r.all.includes(r.key), 'the key is never printed');
  assert.ok(!r.all.includes(r.key.slice(12, 24)), 'nothing of the key beyond its first 12 characters');
}

test('yes + 200: one DELETE to the fixed host, the key is revoked, the local copy is gone', async () => {
  const home = tmpHome();
  try {
    const r = await run();
    assert.equal(r.code, 0);
    assert.equal(r.h.calls.length, 1);
    const o = r.h.calls[0];
    assert.equal(o.method, 'DELETE');
    assert.equal(o.hostname, 'api.usezn.com');
    assert.equal(o.port, 443);
    assert.equal(o.path, '/prod/keys/self');
    assert.equal(o.rejectUnauthorized, true);
    assert.equal(o.headers.Authorization, 'Bearer ' + r.key);
    assert.match(r.out, /Revoked key zn_[0-9a-f]{9}\.\.\. on usezn\.com/);
    assert.equal(r.kc.get(), null);
    assert.equal(cloudKey.readMarker(), null);
    assert.equal(r.t.calls.confirm.length, 1);
    assert.ok(r.t.calls.confirm[0].includes(r.key.slice(0, 12) + '...'), 'the question names the key by the prefix the dashboard shows');
    assertClean(r);
  } finally { cleanup(home); }
});

for (const [status, re] of [[401, /did not accept/], [404, /cannot revoke key .* from here yet/], [400, /cannot revoke key .* from here yet/], [500, /may still work/], [302, /had a problem/]]) {
  test('yes + ' + status + ': says so, links the dashboard, still deletes the local copy', async () => {
    const home = tmpHome();
    try {
      const r = await run({ ans: { status, body: '{"error":"x"}' } });
      assert.equal(r.code, 1);
      assert.match(r.err, re);
      assert.match(r.err, LINK);
      assert.equal(r.kc.get(), null);
      assert.equal(cloudKey.readMarker(), null);
      assertClean(r);
    } finally { cleanup(home); }
  });
}

test('yes + network error: the dashboard is linked and the local copy is gone', async () => {
  const home = tmpHome();
  try {
    const r = await run({ ans: { error: 'ECONNRESET' } });
    assert.equal(r.code, 1);
    assert.match(r.err, /Could not reach usezn\.com \(check your internet connection\)/);
    assert.ok(!/ECONNRESET/.test(r.err));
    assert.match(r.err, LINK);
    assert.equal(r.kc.get(), null);
    assert.equal(cloudKey.readMarker(), null);
    assertClean(r);
  } finally { cleanup(home); }
});

test('an error message that carries the key is scrubbed', async () => {
  const key = freshKey();
  const res = await connectCli.revokeKey({ request() { throw new Error('boom ' + key); } }, key);
  assert.equal(res.state, 'failed');
  assert.ok(!res.detail.includes(key));
});

test('the user says no: no request, local copy deleted, how to revoke is shown', async () => {
  const home = tmpHome();
  try {
    const r = await run({ confirms: [false] });
    assert.equal(r.code, 0);
    assert.equal(r.h.calls.length, 0);
    assert.equal(r.kc.get(), null);
    assert.equal(cloudKey.readMarker(), null);
    assert.match(r.out, LINK);
    assert.match(r.out, /listed as zn_[0-9a-f]{9}\.\.\./);
    assert.doesNotMatch(r.out, /next time|--revoke/, 'no advice that cannot work: the local copy is gone');
    assert.equal(r.t.calls.confirm.length, 1);
    assertClean(r);
  } finally { cleanup(home); }
});

test('no terminal: nothing is revoked, nothing is removed, the dashboard is linked', async () => {
  const home = tmpHome();
  try {
    const r = await run({ human: false, args: ['--revoke'] });
    assert.equal(r.code, 1);
    assert.equal(r.h.calls.length, 0);
    assert.equal(r.t.calls.confirm.length, 0);
    assert.match(r.err, /needs an interactive terminal/);
    assert.match(r.err, LINK);
    assert.ok(r.kc.get(), 'the local copy is untouched: only a person at a terminal changes it');
    assertClean(r);
  } finally { cleanup(home); }
});

test('--revoke skips the question; --no-revoke never asks and never calls', async () => {
  const home = tmpHome();
  try {
    const a = await run({ args: ['--revoke'], confirms: [] });
    assert.equal(a.t.calls.confirm.length, 0);
    assert.equal(a.h.calls.length, 1);
    assert.equal(a.code, 0);
    assert.equal(a.kc.get(), null);
  } finally { cleanup(home); }
  const home2 = tmpHome();
  try {
    const b = await run({ args: ['--no-revoke'], confirms: [true] });
    assert.equal(b.t.calls.confirm.length, 0);
    assert.equal(b.h.calls.length, 0);
    assert.equal(b.kc.get(), null);
    assert.equal(b.code, 0);
  } finally { cleanup(home2); }
});

test('both flags together are a usage error and change nothing', async () => {
  const home = tmpHome();
  try {
    const r = await run({ args: ['--revoke', '--no-revoke'] });
    assert.equal(r.code, 2);
    assert.equal(r.h.calls.length, 0);
    assert.ok(r.kc.get());
  } finally { cleanup(home); }
});

test('TLS environment refusal: no request is sent, the local copy is still deleted', async () => {
  const home = tmpHome();
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const r = await run();
    assert.equal(r.h.calls.length, 0);
    assert.equal(r.code, 1);
    assert.match(r.err, /will not contact usezn\.com while NODE_TLS_REJECT_UNAUTHORIZED is set/);
    assert.match(r.err, LINK);
    assert.equal(r.kc.get(), null);
    assert.equal(cloudKey.readMarker(), null);
    assertClean(r);
  } finally { cleanup(home); }
});

test('marker but the key cannot be read: nothing is removed, revoked or asked, the dashboard is linked', async () => {
  const home = tmpHome();
  try {
    const key = freshKey();
    const kc = memKeychain();
    cloudKey._use(kc.deps);
    await cloudKey.saveKey(key, kc.deps);
    const broken = { native: { ...kc.deps.native, impl: { ...kc.deps.native.impl, load: () => null } }, vault: kc.deps.vault };
    const out = []; const err = [];
    const t = fakeTty({ confirms: [true] });
    const h = fakeHttps({ status: 200 });
    const code = await connectCli.disconnect(['--revoke'], { out: (s) => out.push(s), err: (s) => err.push(s), tty: t, https: h, deps: broken });
    assert.equal(code, 1);
    assert.equal(h.calls.length, 0);
    assert.equal(t.calls.confirm.length, 0);
    assert.match(err.join(''), /Could not read the saved key/);
    assert.match(err.join(''), LINK);
    assert.ok(cloudKey.readMarker(), 'the marker stays');
    assert.equal(kc.get(), key, 'the stored key is untouched');
    // --no-revoke is the explicit way to only remove the local copy
    const code2 = await connectCli.disconnect(['--no-revoke'], { out: () => {}, err: () => {}, tty: fakeTty(), https: h, deps: kc.deps });
    assert.equal(code2, 0);
    assert.equal(cloudKey.readMarker(), null);
  } finally { cleanup(home); }
});

test('--revoke when the local copy cannot be deleted: the key is still revoked, both outcomes are reported, exit 1', async () => {
  const home = tmpHome();
  try {
    const key = freshKey();
    const kc = memKeychain();
    cloudKey._use(kc.deps);
    await cloudKey.saveKey(key, kc.deps);
    const stuck = { native: { ...kc.deps.native, impl: { ...kc.deps.native.impl, remove: () => false } }, vault: kc.deps.vault };
    const out = []; const err = [];
    const h = fakeHttps({ status: 200 });
    const code = await connectCli.disconnect(['--revoke'], { out: (s) => out.push(s), err: (s) => err.push(s), tty: fakeTty(), https: h, deps: stuck });
    assert.equal(code, 1);
    assert.equal(h.calls.length, 1);
    assert.match(err.join(''), /Could not remove the saved key/);
    assert.match(out.join(''), /Revoked key zn_[0-9a-f]{9}\.\.\./);
    assert.ok(!(out.join('') + err.join('')).includes(key));
  } finally { cleanup(home); }
});

test('an AI agent detected through its environment variable: nothing is read, removed or sent, even with --revoke', async () => {
  const home = tmpHome();
  try {
    const key = freshKey();
    const kc = memKeychain();
    cloudKey._use(kc.deps);
    await cloudKey.saveKey(key, kc.deps);
    let loads = 0;
    const spy = { native: { ...kc.deps.native, impl: { ...kc.deps.native.impl, load: (s) => { loads++; return kc.deps.native.impl.load(s); } } }, vault: kc.deps.vault };
    const out = []; const err = [];
    const h = fakeHttps({ status: 200 });
    const code = await connectCli.disconnect(['--revoke'], {
      out: (s) => out.push(s), err: (s) => err.push(s), https: h, deps: spy,
      ttyIo: { env: { CLAUDECODE: '1' }, stdin: { isTTY: true }, ancestry: () => null },
    });
    assert.equal(code, 1);
    assert.match(err.join(''), /not by an AI agent/);
    assert.match(err.join(''), LINK);
    assert.equal(loads, 0, 'the key was never read');
    assert.equal(h.calls.length, 0);
    assert.equal(kc.get(), key);
    assert.ok(cloudKey.readMarker());
    assert.ok(!(out.join('') + err.join('')).includes(key));
  } finally { cleanup(home); }
});
