'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { deadlineLookup, hostsEntries } = require('../lib/dns-deadline');

const HOST = 'api.example.com';

function fakeResolver(handlers) {
  return class FakeResolver {
    constructor() { this.cancelled = false; this.timers = []; }
    resolve4(h, cb) { handlers.a(h, cb, this); }
    resolve6(h, cb) { handlers.aaaa(h, cb, this); }
    cancel() { this.cancelled = true; this.timers.forEach(clearTimeout); }
  };
}
const ok = (addr) => (h, cb) => setImmediate(() => cb(null, [addr]));
const none = (h, cb) => setImmediate(() => cb(Object.assign(new Error('x'), { code: 'ENODATA' })));
// A resolver that never answers in time, as with a network that drops traffic.
const silent = (h, cb, self) => { self.timers.push(setTimeout(() => cb(Object.assign(new Error('x'), { code: 'ETIMEOUT' })), 20000)); };

function run(lookup, host, opts) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    lookup(host || HOST, opts || {}, (err, a, b) => resolve({ err, a, b, ms: Date.now() - t0 }));
  });
}

test('resolves through the resolver (single, all, family)', async () => {
  const lk = deadlineLookup(1000, { Resolver: fakeResolver({ a: ok('192.0.2.7'), aaaa: none }), hostsFile: '/nonexistent' });
  const r = await run(lk);
  assert.strictEqual(r.err, null);
  assert.deepStrictEqual([r.a, r.b], ['192.0.2.7', 4]);
  const all = await run(lk, HOST, { all: true });
  assert.deepStrictEqual(all.a, [{ address: '192.0.2.7', family: 4 }]);
  const both = deadlineLookup(1000, { Resolver: fakeResolver({ a: ok('192.0.2.7'), aaaa: ok('2001:db8::1') }), hostsFile: '/nonexistent' });
  const v6 = await run(both, HOST, { family: 6 });
  assert.deepStrictEqual([v6.a, v6.b], ['2001:db8::1', 6]);
});

test('a hosts file entry wins and no query is made', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-hosts-')), 'hosts');
  fs.writeFileSync(f, '# c\n198.51.100.9  other.example.com Api.Example.Com # trailing\n');
  assert.deepStrictEqual(hostsEntries(HOST, f), [{ address: '198.51.100.9', family: 4 }]);
  const lk = deadlineLookup(1000, { Resolver: fakeResolver({ a: silent, aaaa: silent }), hostsFile: f });
  const r = await run(lk);
  assert.strictEqual(r.a, '198.51.100.9');
  assert.ok(r.ms < 100);
});

test('a lookup that never answers fails at the deadline and cancels the queries', async () => {
  let res;
  const R = fakeResolver({ a: (h, cb, s) => { res = s; silent(h, cb, s); }, aaaa: silent });
  const r = await run(deadlineLookup(300, { Resolver: R, hostsFile: '/nonexistent', lookup: () => assert.fail('no fallback on a timeout') }));
  assert.strictEqual(r.err.code, 'ETIMEDOUT');
  assert.ok(r.ms >= 250 && r.ms < 800, 'took ' + r.ms);
  assert.strictEqual(res.cancelled, true);
});

test('no such name falls back to the system lookup, which is also bounded', async () => {
  const sys = (h, o, cb) => setImmediate(() => cb(null, [{ address: '203.0.113.5', family: 4 }]));
  const lk = deadlineLookup(1000, { Resolver: fakeResolver({ a: none, aaaa: none }), hostsFile: '/nonexistent', lookup: sys });
  const r = await run(lk);
  assert.strictEqual(r.a, '203.0.113.5');
  const slowSys = (h, o, cb) => setTimeout(() => cb(null, [{ address: '203.0.113.5', family: 4 }]), 20000).unref();
  const r2 = await run(deadlineLookup(300, { Resolver: fakeResolver({ a: none, aaaa: none }), hostsFile: '/nonexistent', lookup: slowSys }));
  assert.strictEqual(r2.err.code, 'ETIMEDOUT');
  assert.ok(r2.ms < 800);
});

test('a hung lookup does not keep the process alive past the deadline', () => {
  const lib = JSON.stringify(path.join(__dirname, '..', 'lib', 'dns-deadline'));
  const script = [
    "const { deadlineLookup } = require(" + lib + ");",
    "class R { constructor(){this.t=[]} resolve4(h,cb){this.t.push(setTimeout(()=>cb(Object.assign(new Error('x'),{code:'ETIMEOUT'})),20000))} resolve6(h,cb){this.resolve4(h,cb)} cancel(){this.t.forEach(clearTimeout)} }",
    "deadlineLookup(400, { Resolver: R, hostsFile: '/nonexistent' })('api.example.com', {}, (e) => console.log(e.code));",
  ].join('\n');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  const ms = Date.now() - t0;
  assert.strictEqual(r.stdout.trim(), 'ETIMEDOUT');
  assert.ok(ms < 3000, 'process lived ' + ms + ' ms');
});
