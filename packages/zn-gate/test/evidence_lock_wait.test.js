'use strict';
// The ledger lock wait is configurable (ZN_EVIDENCE_LOCK_WAIT_MS, longer on a network file system), and an event
// that cannot be written is counted and shown by `zn-gate stats`. No real NFS: the mount table is a temp file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-evlockwait-'));
process.env.ZN_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ZN_STATS;
delete process.env.ZN_EVIDENCE_LOCK_WAIT_MS;
const evidence = require('../lib/evidence');
const stats = require('../lib/stats');
const cli = require('../lib/stats-cli');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const quiet = (fn) => {
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  try { return fn(); } finally { process.stderr.write = orig; }
};

test('the wait is 2 s locally and ZN_EVIDENCE_LOCK_WAIT_MS overrides it', () => {
  const file = path.join(home, 'a', 'evidence.jsonl');
  assert.equal(evidence.lockWaitFor(file), 2000);
  process.env.ZN_EVIDENCE_LOCK_WAIT_MS = '7500';
  assert.equal(evidence.lockWaitFor(file), 7500);
  for (const bad of ['abc', '-5', '1.5', '', '600001']) {
    process.env.ZN_EVIDENCE_LOCK_WAIT_MS = bad;
    assert.equal(evidence.lockWaitFor(file), 2000, bad);
  }
  delete process.env.ZN_EVIDENCE_LOCK_WAIT_MS;
});

test('a ledger folder on nfs or cifs is detected as a network file system', () => {
  const dir = path.join(home, 'mnt', 'share');
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.realpathSync(home);
  const mounts = path.join(home, 'mounts');
  fs.writeFileSync(mounts, `/dev/sda1 / ext4 rw 0 0\nsrv:/x ${real}/mnt nfs4 rw 0 0\n`);
  assert.equal(evidence.onNetworkFs(dir, mounts), true);
  fs.writeFileSync(mounts, `//srv/x ${real}/mnt cifs rw 0 0\n`);
  assert.equal(evidence.onNetworkFs(dir, mounts), true);
  // The longest matching mount wins: a local disk mounted below the network share is local.
  fs.writeFileSync(mounts, `srv:/x ${real}/mnt nfs rw 0 0\n/dev/sdb ${real}/mnt/share ext4 rw 0 0\n`);
  assert.equal(evidence.onNetworkFs(dir, mounts), false);
  fs.writeFileSync(mounts, '/dev/sda1 / ext4 rw 0 0\n');
  assert.equal(evidence.onNetworkFs(dir, mounts), false);
  assert.equal(evidence.onNetworkFs(dir, path.join(home, 'missing')), false);
});

test('an event dropped because the lock stays held is counted, and stats shows it', async () => {
  const ledger = path.join(home, 'evidence.jsonl');
  assert.equal(stats.droppedCount(), 0);
  fs.writeFileSync(ledger + '.lock', `${process.pid}:held`); // a fresh lock held by someone else
  let r;
  quiet(() => { r = evidence.logEvidence({ payload: 'x' }, ledger, { lockWaitMs: 50, noStats: true }); });
  assert.equal(r, null);
  assert.equal(stats.droppedCount(), 1);
  quiet(() => { evidence.logEvidence({ payload: 'y' }, ledger, { lockWaitMs: 50, noStats: true }); });
  assert.equal(stats.droppedCount(), 2);
  assert.equal(stats.summary().evidenceDropped, 2);

  let out = '';
  assert.equal(await cli.run([], (s) => { out += s; }, { confirm: async () => false }), 0);
  assert.match(out, /2 evidence log events could not be written/);
  assert.match(out, /ZN_EVIDENCE_LOCK_WAIT_MS/);
  out = '';
  await cli.run(['--json'], (s) => { out += s; }, { confirm: async () => false });
  assert.equal(JSON.parse(out).evidenceDropped, 2);
});

test('a successful write does not count, and the line is absent when the count is zero', async () => {
  fs.rmSync(path.join(home, 'evidence.jsonl.lock'), { force: true });
  fs.rmSync(path.join(home, 'evidence.jsonl.dropped'), { force: true });
  const ledger = path.join(home, 'evidence.jsonl');
  const r = evidence.logEvidence({ payload: 'z' }, ledger, { noStats: true });
  assert.ok(r && r.record_hash);
  assert.equal(stats.droppedCount(), 0);
  let out = '';
  await cli.run([], (s) => { out += s; }, { confirm: async () => false });
  assert.doesNotMatch(out, /could not be written/);
});

test('ZN_EVIDENCE_LOCK_WAIT_MS is used when no wait is passed', () => {
  const ledger = path.join(home, 'evidence.jsonl');
  fs.writeFileSync(ledger + '.lock', `${process.pid}:held`);
  process.env.ZN_EVIDENCE_LOCK_WAIT_MS = '0';
  const t = Date.now();
  let r;
  quiet(() => { r = evidence.logEvidence({ payload: 'x' }, ledger, { noStats: true }); });
  delete process.env.ZN_EVIDENCE_LOCK_WAIT_MS;
  assert.equal(r, null);
  assert.ok(Date.now() - t < 1500);
  assert.equal(stats.droppedCount(), 1);
});
