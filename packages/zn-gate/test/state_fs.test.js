'use strict';

// The state folder probe (lib/state-fs.js): permissions that stick, Unix sockets, and what check, unlock, vault init
// and the vault daemon say when the folder (FAT, exFAT, an SMB share) has neither. The file system is injected.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const stateFs = require('../lib/state-fs');
const { check, report } = require('../lib/check');
const { unlockCmd } = require('../lib/vault/cli');
const keychain = require('../lib/vault/keychain');
const daemon = require('../lib/vault/daemon');
const { tempDir } = require('./helpers/tmp');

// A fake file system layer. `mode` is what stat reads back after chmod 0600; `bind` is the socket result.
function layer({ mode = 0o600, bind = null, dirs = null, createError = null, bindThrows = null } = {}) {
  const calls = { created: [], unlinked: [], bound: [], chmod: [] };
  return {
    calls,
    isDir: (d) => (dirs ? dirs.includes(d) : true),
    create: (f) => { if (createError) throw Object.assign(new Error('x'), { code: createError }); calls.created.push(f); },
    chmod: (f, m) => { calls.chmod.push([f, m]); },
    modeOf: () => mode,
    unlink: (f) => { calls.unlinked.push(f); },
    bindSocket: async (a) => { calls.bound.push(a); if (bindThrows) throw Object.assign(new Error('x'), { code: bindThrows }); return bind; },
  };
}

const FOLDER = path.resolve('/zn-test/state');
// The Node.js version advice is also in warnings; these tests are about the state folder one.
const stateWarnings = (res) => res.warnings.filter((w) => w.includes('keeps its private state'));

test('a normal Unix folder: permissions stick and sockets bind', async () => {
  const l = layer();
  const r = await stateFs.support({ folder: FOLDER, layer: l });
  assert.deepEqual(r, { folder: FOLDER, permissions_enforced: true, unix_sockets: true });
  assert.equal(stateFs.problemText(r), '');
  assert.equal(l.calls.chmod[0][1], 0o600, 'the probe file is chmod 0600');
  assert.equal(l.calls.created.length, 1);
  assert.deepEqual(l.calls.unlinked.sort(), [l.calls.created[0], l.calls.bound[0]].sort(), 'both probe files are removed');
});

test('vfat: chmod is a no-op (mode stays 0755) and a Unix socket gives EPERM', async () => {
  const r = await stateFs.support({ folder: FOLDER, layer: layer({ mode: 0o755, bind: 'EPERM' }) });
  assert.equal(r.permissions_enforced, false);
  assert.equal(r.unix_sockets, false);
  const text = stateFs.problemText(r);
  assert.ok(text.includes(FOLDER), 'names the folder');
  assert.match(text, /ignores Unix file permissions and cannot hold Unix sockets/);
  assert.match(text, /set ZN_HOME to a folder on a disk with Unix permissions, such as your home disk/);
});

test('cifs: ENOTSUP for the socket; only sockets missing, or only permissions missing', async () => {
  const sock = await stateFs.support({ folder: FOLDER, layer: layer({ bind: 'ENOTSUP' }) });
  assert.equal(sock.permissions_enforced, true);
  assert.equal(sock.unix_sockets, false);
  assert.match(stateFs.problemText(sock), /cannot hold Unix sockets.*vault cannot run there/);
  assert.doesNotMatch(stateFs.problemText(sock), /readable by other users/);
  const perm = await stateFs.support({ folder: FOLDER, layer: layer({ mode: 0o644 }) });
  assert.equal(perm.permissions_enforced, false);
  assert.equal(perm.unix_sockets, true);
  assert.match(stateFs.problemText(perm), /ignores Unix file permissions.*readable by other users/);
  assert.doesNotMatch(stateFs.problemText(perm), /vault cannot run/);
});

test('a probe that cannot run never claims a problem', async () => {
  for (const createError of ['EROFS', 'EACCES', 'ENOSPC']) {
    const r = await stateFs.support({ folder: FOLDER, layer: layer({ createError }) });
    assert.equal(r.permissions_enforced, true, createError);
  }
  for (const bind of ['EACCES', 'EADDRINUSE', 'ENAMETOOLONG', 'EROFS']) {
    const r = await stateFs.support({ folder: FOLDER, layer: layer({ bind }) });
    assert.equal(r.unix_sockets, true, bind);
  }
  assert.equal((await stateFs.support({ folder: FOLDER, layer: layer({ bindThrows: 'EPERM' }) })).unix_sockets, false);
  const tooLong = path.join(path.resolve('/zn-test'), 'x'.repeat(120));
  const l = layer({ bind: 'EPERM' });
  assert.equal((await stateFs.support({ folder: tooLong, layer: l })).unix_sockets, true, 'a path too long for a socket is inconclusive');
  assert.equal(l.calls.bound.length, 0);
});

test('a folder that does not exist yet is not created: its nearest parent is probed, and run/ is used when it exists', async () => {
  const parent = path.resolve('/zn-test');
  const l = layer({ dirs: [parent], bind: 'EPERM' });
  await stateFs.support({ folder: path.join(parent, 'new', 'deeper'), layer: l });
  assert.equal(path.dirname(l.calls.created[0]), parent);
  assert.equal(path.dirname(l.calls.bound[0]), parent);
  const withRun = layer({ dirs: [FOLDER, path.join(FOLDER, 'run')] });
  await stateFs.support({ folder: FOLDER, layer: withRun });
  assert.equal(path.dirname(withRun.calls.bound[0]), path.join(FOLDER, 'run'));
  assert.equal(path.dirname(withRun.calls.created[0]), FOLDER);
});

test('a real folder on this disk: both supported, nothing left behind, nothing created', async (t) => {
  const dir = tempDir(t, 'zn-statefs-');
  const folder = path.join(dir, 'state');
  stateFs._clearCache();
  const r = await stateFs.support({ folder });
  assert.equal(r.unix_sockets, true);
  assert.equal(r.permissions_enforced, true);
  assert.equal(fs.existsSync(folder), false, 'the state folder was not created');
  assert.deepEqual(fs.readdirSync(dir), [], 'no probe file is left in the parent');
  fs.mkdirSync(folder);
  const again = await stateFs.support({ folder });
  assert.equal(again.unix_sockets && again.permissions_enforced, true);
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('the answer is cached for the process', async (t) => {
  const dir = tempDir(t, 'zn-statefs-');
  stateFs._clearCache();
  const first = await stateFs.support({ folder: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  const second = await stateFs.support({ folder: dir });
  assert.deepEqual(second, first);
});

test('check: a folder without permissions or sockets gives a warning; a normal one gives none', async () => {
  const bad = { folder: FOLDER, permissions_enforced: false, unix_sockets: false };
  const res = await check({ live: false, nodeVersion: '22.0.0', hookNode: null, stateFolder: bad });
  assert.equal(stateWarnings(res).length, 1);
  assert.ok(stateWarnings(res)[0].includes(FOLDER));
  assert.match(stateWarnings(res)[0], /set ZN_HOME/);
  let text = '';
  report(res, (s) => { text += s; });
  assert.match(text, /Warning: The folder where zn keeps its private state/);
  const good = await check({ live: false, nodeVersion: '22.0.0', hookNode: null, stateFolder: { folder: FOLDER, permissions_enforced: true, unix_sockets: true } });
  assert.deepEqual(stateWarnings(good), []);
});

test('check on a real ZN_HOME on this disk gives no state folder warning', async (t) => {
  const dir = tempDir(t, 'zn-statefs-');
  const old = process.env.ZN_HOME;
  process.env.ZN_HOME = path.join(dir, 'zn');
  t.after(() => { if (old === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = old; });
  stateFs._clearCache();
  const res = await check({ live: false, nodeVersion: '22.0.0', hookNode: null });
  assert.deepEqual(stateWarnings(res), []);
});

test('zn unlock refuses on such a folder with the fix, before anything is asked', async () => {
  let asked = 0;
  const stateSupport = async () => ({ folder: FOLDER, permissions_enforced: false, unix_sockets: true });
  await assert.rejects(unlockCmd(['unlock'], {
    agent: null,
    stateSupport,
    getPassphrase: async () => { asked += 1; return 'fake-pass-12345'; },
  }), (err) => /^zn unlock will not start: The folder where zn keeps its private state/.test(err.message) && err.message.includes(FOLDER) && /ZN_HOME/.test(err.message));
  assert.equal(asked, 0);
  await assert.rejects(unlockCmd(['unlock'], {
    agent: null,
    stateSupport: async () => ({ folder: FOLDER, permissions_enforced: true, unix_sockets: false }),
  }), /cannot hold Unix sockets/);
});

test('vault init refuses on a folder that ignores permissions and creates nothing', async (t) => {
  const home = path.join(tempDir(t, 'zn-statefs-'), 'zn');
  await assert.rejects(
    keychain.initIdentity({ home, passphrase: 'correct horse battery staple', workFactor: 10, backend: 'passphrase', stateFs: { layer: layer({ mode: 0o755 }) } }),
    (err) => /will not be created/.test(err.message) && err.message.includes(home) && /ZN_HOME/.test(err.message),
  );
  assert.equal(fs.existsSync(home), false);
});

test('vault init on a normal folder is unchanged', async (t) => {
  const home = path.join(tempDir(t, 'zn-statefs-'), 'zn');
  const r = await keychain.initIdentity({ home, passphrase: 'correct horse battery staple', workFactor: 10, backend: 'passphrase' });
  assert.equal(r.backend, 'passphrase');
});

test('the vault daemon names the real cause when the folder ignores chmod, and keeps its message otherwise', (t) => {
  const dir = tempDir(t, 'zn-statefs-');
  const run = path.join(dir, 'run');
  fs.mkdirSync(run, { mode: 0o700 });
  const ep = { unix: true, address: path.join(run, 'vault.sock'), keyFile: path.join(run, 'session.key') };
  fs.chmodSync(run, 0o750);
  // On this disk chmod works: the old message stands.
  assert.throws(() => daemon.assertPrivateEndpoint(ep), (err) => /is not private to your user/.test(err.message));
  const real = stateFs.permissionsEnforced;
  stateFs.permissionsEnforced = () => false; // as on vfat: the mode never changes
  t.after(() => { stateFs.permissionsEnforced = real; });
  assert.throws(() => daemon.assertPrivateEndpoint(ep), (err) => err.message.startsWith('the vault will not start: The folder where zn keeps its private state (' + dir + ')')
    && /ignores Unix file permissions/.test(err.message) && /ZN_HOME/.test(err.message));
});
