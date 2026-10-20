'use strict';

// A keychain marker with no usable keychain must not trap the person, and a damaged vault file
// gets one plain sentence with a real next step. Fake keys, temporary ZN_HOME, no real keychain.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const childProcess = require('child_process');
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = () => ({ error: Object.assign(new Error('blocked in tests'), { code: 'EBLOCKED' }) });
const keychain = require('../lib/vault/keychain');
const store = require('../lib/vault/store');
childProcess.spawnSync = realSpawnSync;
const cloudKey = require('../lib/cloud-key');
const connectCli = require('../lib/connect-cli');
const { messageWithUnlockHint } = require('../lib/errors');

const freshKey = () => 'zn_' + crypto.randomBytes(24).toString('hex');

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stuck-'));
  process.env.ZN_HOME = dir;
  return dir;
}
function cleanup(dir) {
  cloudKey._use(null);
  delete process.env.ZN_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

// A marker written by connect, then a machine whose keychain is gone.
async function stuckMachine() {
  let mem = null;
  const slot = { service: 'zn-cloud', account: 'cloud-api-key' };
  const impl = { store: (k) => { mem = k; }, load: () => mem, remove: () => { mem = null; return true; } };
  const withKeychain = { native: { name: 'fake', slot, impl }, vault: { isUnlocked: async () => false } };
  await cloudKey.saveKey(freshKey(), withKeychain);
  const none = { native: null, vault: { isUnlocked: async () => false } };
  cloudKey._use(none);
  return none;
}

async function disconnectWith(args, deps) {
  const out = []; const err = [];
  const tty = { requireHuman() {}, async confirm() { return false; } };
  const code = await connectCli.disconnect(args, { out: (s) => out.push(s), err: (s) => err.push(s), tty, https: null, deps });
  return { code, out: out.join(''), err: err.join(''), all: out.join('') + err.join('') };
}

for (const args of [[], ['--no-revoke']]) {
  test('disconnect ' + args.join(' ') + ' with a marker and no keychain removes the marker and exits 0', async () => {
    const home = tmpHome();
    try {
      const deps = await stuckMachine();
      assert.notEqual(cloudKey.readMarker(), null);
      const r = await disconnectWith(args, deps);
      assert.equal(r.code, 0, r.all);
      assert.equal(cloudKey.readMarker(), null, 'the marker is gone, so connect no longer says "Already connected"');
      assert.match(r.all, /Removed the connect setting/);
      assert.match(r.all, /Could not clean your system keychain/);
      assert.match(r.all, /delete the item named "zn-cloud"/);
      assert.match(r.all, /https:\/\/usezn\.com\/api-keys/);
      assert.ok(!/\bunlock\b/.test(r.all), 'no unlock hint for a keychain');
    } finally { cleanup(home); }
  });
}

test('disconnect with the vault locked says the unlock step once', async () => {
  const home = tmpHome();
  try {
    await cloudKey.saveKey(freshKey(), { native: null, vault: { isUnlocked: async () => true, setSecret: async () => {} } });
    const locked = Object.assign(new Error('vault is locked; run `zn unlock`'), { code: 'ZN_LOCKED' });
    const deps = { native: null, vault: { isUnlocked: async () => false, removeSecret: async () => { throw locked; } } };
    cloudKey._use(deps);
    const r = await disconnectWith(['--no-revoke'], deps);
    assert.equal(r.code, 1);
    assert.equal((r.err.match(/unlock/g) || []).length, 1, r.err);
    assert.notEqual(cloudKey.readMarker(), null, 'the marker stays so a second try finds it');
  } finally { cleanup(home); }
});

function damagedVault() {
  const home = tmpHome();
  const metaFile = store.paths({ home }).metaFile;
  fs.mkdirSync(path.dirname(metaFile), { recursive: true });
  fs.writeFileSync(metaFile, 'not json');
  return home;
}

function assertPlainDamaged(msg, file) {
  assert.ok(msg.includes('Your vault file ' + file), msg);
  assert.ok(!msg.includes('.;'), 'no broken punctuation: ' + msg);
  assert.ok(!/docs\/troubleshooting\.md/.test(msg), 'a public link, not a repo path');
  assert.match(msg, /https:\/\/usezn\.com\/docs\/troubleshooting/);
  assert.match(msg, /vault reset/);
  assert.match(msg, /starts empty/);
  assert.match(msg, /Restore it from a backup/);
  assert.ok(!/invalid version|no identity matched/i.test(msg), 'no library detail');
}

test('damaged keychain.json: one plain sentence, one next step, no repeated unlock hint', () => {
  const home = damagedVault();
  try {
    let err = null;
    try { keychain.readMeta({ home }); } catch (e) { err = e; }
    assert.ok(err);
    assertPlainDamaged(err.message, 'keychain.json');
    const shown = messageWithUnlockHint(err);
    assert.equal(shown, err.message, 'the unlock hint is not added to a damaged-file message');
    assert.ok(!shown.includes('; run'));
  } finally { cleanup(home); }
});

test('damaged secrets.age: no library detail unless ZN_VERBOSE=1', async () => {
  const home = tmpHome();
  try {
    const f = path.join(home, 'secrets.age');
    fs.writeFileSync(f, 'garbage that is not an age file');
    const { identity } = await store.generateIdentity();
    let err = null;
    try { await store.readEncrypted(f, identity); } catch (e) { err = e; }
    assert.ok(err);
    assertPlainDamaged(err.message, 'secrets.age');
    assert.ok(!/invalid|version|header/i.test(err.message), err.message);
    process.env.ZN_VERBOSE = '1';
    try {
      let v = null;
      try { await store.readEncrypted(f, identity); } catch (e) { v = e; }
      assert.match(v.message, /Detail: /);
    } finally { delete process.env.ZN_VERBOSE; }
  } finally { cleanup(home); }
});
