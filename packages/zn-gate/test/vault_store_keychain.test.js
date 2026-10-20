'use strict';
/**
 * Vault internals: store (age files, permissions, housekeeping) and keychain
 * (metadata, passphrase backend, error paths). Every test uses its own
 * temporary ZN_HOME. Native keychain backends are replaced by in-memory stubs;
 * the real OS keychain is never called. All values are fake.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// No test may reach a real keychain helper: keychain.js keeps its own reference to
// spawnSync from load time, so the recorder is put in place before it is required.
const childProcess = require('child_process');
const helperCalls = [];
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (cmd) => { helperCalls.push(cmd); return { error: Object.assign(new Error('blocked in tests'), { code: 'EBLOCKED' }) }; };
const store = require('../lib/vault/store');
const keychain = require('../lib/vault/keychain');
childProcess.spawnSync = realSpawnSync;
const audit = require('../lib/vault/audit');

const POSIX = process.platform !== 'win32';
const PASS = 'fake-passphrase-for-tests';
const WF = 10;
const INITIAL_ENV = { ZN_HOME: process.env.ZN_HOME, ZN_KEYCHAIN_PATH: process.env.ZN_KEYCHAIN_PATH, ZN_KEYCHAIN_SERVICE: process.env.ZN_KEYCHAIN_SERVICE, ZN_KEYCHAIN_BACKEND: process.env.ZN_KEYCHAIN_BACKEND };

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'znvx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withEnv(t, vars) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  t.after(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
}

/* In-memory replacement for one native backend; restored after the test. */
function stubNative(t, name, impl) {
  const be = keychain._native[name];
  const orig = { store: be.store, load: be.load, remove: be.remove };
  be.store = impl.store; be.load = impl.load; be.remove = impl.remove;
  t.after(() => { be.store = orig.store; be.load = orig.load; be.remove = orig.remove; });
}

function memoryBackend() {
  const m = { value: null, removed: 0 };
  return {
    m,
    store(id) { m.value = id; },
    load() { return m.value; },
    remove() { m.removed++; m.value = null; return true; },
  };
}

async function newVault(t) {
  const home = tmpHome(t);
  const r = await keychain.initIdentity({ home, backend: 'passphrase', passphrase: PASS, workFactor: WF });
  return { home, r };
}

/* ---------------- store: paths and keys ---------------- */

test('znHome: explicit option wins, then ZN_HOME, then the user home', (t) => {
  withEnv(t, { ZN_HOME: path.join(os.tmpdir(), 'znvx-env') });
  assert.equal(store.znHome({ home: path.join(os.tmpdir(), 'znvx-opt') }), path.resolve(os.tmpdir(), 'znvx-opt'));
  assert.equal(store.znHome(), path.resolve(os.tmpdir(), 'znvx-env'));
  delete process.env.ZN_HOME;
  assert.equal(store.znHome(), path.join(os.homedir(), '.zn'));
});

test('normalizeProject: empty values and relative ids are kept as given', () => {
  assert.equal(store.normalizeProject(null), '');
  assert.equal(store.normalizeProject(undefined), '');
  assert.equal(store.normalizeProject('project-id-1'), 'project-id-1');
  assert.notEqual(store.projectKey(''), store.projectKey('project-id-1'));
});

/* ---------------- store: private files ---------------- */

test('writePrivateFile and readPrivateFile round trip, leave no temporary file', (t) => {
  const home = tmpHome(t);
  const file = path.join(home, 'vault', 'x.bin');
  store.writePrivateFile(file, Buffer.from('fake-value-for-tests'));
  assert.equal(store.readPrivateFile(file).toString(), 'fake-value-for-tests');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['x.bin']);
  if (POSIX) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('readPrivateFile: missing file is null, a directory is refused', (t) => {
  const home = tmpHome(t);
  assert.equal(store.readPrivateFile(path.join(home, 'nothing')), null);
  const dir = path.join(home, 'adir');
  fs.mkdirSync(dir);
  assert.throws(() => store.readPrivateFile(dir), (e) => e.code === 'ZN_POLICY_DENIED' && /not a regular file/.test(e.message));
});

test('readPrivateFile refuses a symbolic link', { skip: !POSIX && 'symlinks need privileges on Windows' }, (t) => {
  const home = tmpHome(t);
  const real = path.join(home, 'real');
  fs.writeFileSync(real, 'fake-value-for-tests');
  const link = path.join(home, 'link');
  fs.symlinkSync(real, link);
  assert.throws(() => store.readPrivateFile(link), (e) => e.code === 'ZN_POLICY_DENIED');
});

test('writePrivateFile: a failed rename removes its temporary file and reports the error', (t) => {
  const home = tmpHome(t);
  const dir = path.join(home, 'vault');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'blocked');
  fs.mkdirSync(target); // renaming a file over a directory fails
  assert.throws(() => store.writePrivateFile(target, Buffer.from('fake-value-for-tests')));
  assert.deepEqual(fs.readdirSync(dir), ['blocked']);
});

/* ---------------- store: directories ---------------- */

test('ensurePrivateDir closes a directory that was open to group and others', { skip: !POSIX && 'POSIX modes' }, (t) => {
  const home = tmpHome(t);
  const dir = path.join(home, 'open');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  store.ensurePrivateDir(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('ensurePrivateDir refuses a symbolic link in place of a directory', { skip: !POSIX && 'symlinks need privileges on Windows' }, (t) => {
  const home = tmpHome(t);
  const real = path.join(home, 'real');
  fs.mkdirSync(real);
  const link = path.join(home, 'link');
  fs.symlinkSync(real, link);
  assert.throws(() => store.ensurePrivateDir(link), (e) => e.code === 'ZN_POLICY_DENIED' && /not a directory/.test(e.message));
});

test('ensureLayout creates home, vault and run directories', { skip: !POSIX && 'POSIX modes' }, (t) => {
  const home = path.join(tmpHome(t), 'nested', 'zn');
  const p = store.ensureLayout({ home });
  for (const d of [p.home, p.vaultDir, p.runDir]) {
    assert.equal(fs.statSync(d).mode & 0o777, 0o700);
  }
});

/* ---------------- store: age ---------------- */

test('age: identity round trip, and a different identity cannot decrypt', async () => {
  const a = await store.generateIdentity();
  const b = await store.generateIdentity();
  assert.equal(await store.recipientOf(a.identity), a.recipient);
  const ct = await store.encryptTo(a.recipient, 'fake-value-for-tests');
  assert.equal(await store.decryptWith(a.identity, ct), 'fake-value-for-tests');
  await assert.rejects(() => store.decryptWith(b.identity, ct));
});

test('age: passphrase round trip; wrong passphrase and a truncated file fail', async () => {
  const ct = await store.encryptWithPassphrase(PASS, 'fake-value-for-tests', WF);
  assert.equal(await store.decryptWithPassphrase(PASS, ct), 'fake-value-for-tests');
  await assert.rejects(() => store.decryptWithPassphrase('another-fake-passphrase', ct));
  await assert.rejects(() => store.decryptWithPassphrase(PASS, ct.slice(0, Math.floor(ct.length / 2))));
});

/* ---------------- store: encrypted JSON ---------------- */

test('writeEncrypted and readEncrypted round trip; a missing file is null', async (t) => {
  const home = tmpHome(t);
  const { identity, recipient } = await store.generateIdentity();
  const file = path.join(home, 'vault', 'one.age');
  assert.equal(await store.readEncrypted(file, identity), null);
  await store.writeEncrypted(file, { v: 1, map: { A: 'fake-value-for-tests' } }, recipient);
  assert.deepEqual(await store.readEncrypted(file, identity), { v: 1, map: { A: 'fake-value-for-tests' } });
  assert.doesNotMatch(fs.readFileSync(file).toString('latin1'), /fake-value-for-tests/);
});

test('readEncrypted: wrong key, garbage, truncation and non-JSON content fail closed without leaking', async (t) => {
  const home = tmpHome(t);
  const a = await store.generateIdentity();
  const b = await store.generateIdentity();
  const file = path.join(home, 'vault', 'two.age');
  await store.writeEncrypted(file, { secret: 'fake-value-for-tests' }, a.recipient);
  const good = fs.readFileSync(file);

  const expectLocked = async () => {
    await assert.rejects(() => store.readEncrypted(file, a.identity), (e) => {
      assert.equal(e.code, 'ZN_LOCKED');
      assert.match(e.message, /two\.age/);
      assert.match(e.message, /zn will not read or replace it/);
      assert.doesNotMatch(e.message, /fake-value-for-tests|AGE-SECRET-KEY/);
      return true;
    });
  };

  await assert.rejects(() => store.readEncrypted(file, b.identity), (e) => e.code === 'ZN_LOCKED');
  fs.writeFileSync(file, good.subarray(0, good.length - 20));
  await expectLocked();
  fs.writeFileSync(file, 'this is not an age file');
  await expectLocked();
  fs.writeFileSync(file, Buffer.alloc(0));
  await expectLocked();
  // valid age file whose plaintext is not JSON
  fs.writeFileSync(file, Buffer.from(await store.encryptTo(a.recipient, 'not json {')));
  await expectLocked();
});

/* ---------------- store: housekeeping ---------------- */

test('hasPriorState: false when empty, true with an audit log or a project map', async (t) => {
  const home = tmpHome(t);
  assert.equal(store.hasPriorState({ home }), false);
  const p = store.ensureLayout({ home });
  assert.equal(store.hasPriorState({ home }), false);
  fs.writeFileSync(p.auditFile, '');
  assert.equal(store.hasPriorState({ home }), false);
  fs.writeFileSync(p.auditFile, '{}\n');
  assert.equal(store.hasPriorState({ home }), true);
  fs.rmSync(p.auditFile);
  fs.writeFileSync(path.join(p.vaultDir, 'notes.txt'), 'x');
  assert.equal(store.hasPriorState({ home }), false);
  fs.writeFileSync(store.projectFile('/work/app', { home }), 'x');
  assert.equal(store.hasPriorState({ home }), true);
});

test('pruneStale removes only old project maps and honours the days option', (t) => {
  const home = tmpHome(t);
  const p = store.ensureLayout({ home });
  const oldMap = store.projectFile('/work/old', { home });
  const newMap = store.projectFile('/work/new', { home });
  const other = path.join(p.vaultDir, 'secrets.age');
  for (const f of [oldMap, newMap, other]) fs.writeFileSync(f, 'x');
  const past = new Date(Date.now() - 40 * 86400000);
  fs.utimesSync(oldMap, past, past);
  fs.utimesSync(other, past, past); // not a project map: never pruned
  assert.equal(store.pruneStale({ home }), 1);
  assert.equal(fs.existsSync(oldMap), false);
  assert.equal(fs.existsSync(newMap), true);
  assert.equal(fs.existsSync(other), true);
  const recent = new Date(Date.now() - 2 * 86400000);
  fs.utimesSync(newMap, recent, recent);
  assert.equal(store.pruneStale({ home, days: 1 }), 1);
  assert.equal(store.pruneStale({ home: path.join(home, 'nope') }), 0);
});

test('forgetProject reports whether a map existed; touch never throws', (t) => {
  const home = tmpHome(t);
  store.ensureLayout({ home });
  const f = store.projectFile('/work/app', { home });
  assert.equal(store.forgetProject('/work/app', { home }), false);
  fs.writeFileSync(f, 'x');
  const past = new Date(Date.now() - 5 * 86400000);
  fs.utimesSync(f, past, past);
  store.touch(f);
  assert.ok(Date.now() - fs.statSync(f).mtimeMs < 60000);
  assert.equal(store.forgetProject('/work/app', { home }), true);
  assert.equal(fs.existsSync(f), false);
  assert.doesNotThrow(() => store.touch(path.join(home, 'missing')));
});

/* ---------------- keychain: configuration ---------------- */

test('detectBackend: a forced backend is used; an unknown one is refused', (t) => {
  withEnv(t, { ZN_KEYCHAIN_BACKEND: 'passphrase' });
  assert.equal(keychain.detectBackend(), 'passphrase');
  process.env.ZN_KEYCHAIN_BACKEND = 'libsecret';
  assert.equal(keychain.detectBackend(), 'libsecret');
  process.env.ZN_KEYCHAIN_BACKEND = 'fake-backend';
  assert.throws(() => keychain.detectBackend(), (e) => e.code === 'ZN_POLICY_DENIED' && /unknown keychain backend: fake-backend/.test(e.message));
});

test('detectBackend without an override picks a known backend', (t) => {
  withEnv(t, { ZN_KEYCHAIN_BACKEND: undefined, DBUS_SESSION_BUS_ADDRESS: undefined });
  assert.ok(keychain.BACKENDS.includes(keychain.detectBackend()));
  if (process.platform === 'linux') assert.equal(keychain.detectBackend(), 'passphrase');
});

test('an invalid service name or keychain path is refused before any helper runs', (t) => {
  withEnv(t, { ZN_KEYCHAIN_SERVICE: 'bad name; rm', ZN_KEYCHAIN_PATH: undefined });
  const before = helperCalls.length;
  assert.throws(() => keychain._native.macos.store('AGE-SECRET-KEY-1FAKE'), (e) => e.code === 'ZN_POLICY_DENIED' && /ZN_KEYCHAIN_SERVICE/.test(e.message));
  process.env.ZN_KEYCHAIN_SERVICE = 'zn-vault-test';
  process.env.ZN_KEYCHAIN_PATH = path.join(os.tmpdir(), 'a folder with spaces', 'fake.keychain');
  assert.throws(() => keychain._native.macos.store('AGE-SECRET-KEY-1FAKE'), (e) => e.code === 'ZN_POLICY_DENIED' && /must not contain spaces/.test(e.message));
  assert.equal(helperCalls.length, before);
});

test('a native helper that cannot start is reported as locked, and the blocked launcher saw the call', (t) => {
  withEnv(t, { ZN_KEYCHAIN_SERVICE: 'zn-vault-test', ZN_KEYCHAIN_PATH: undefined });
  const before = helperCalls.length;
  assert.throws(() => keychain._native.macos.load(), (e) => e.code === 'ZN_LOCKED' && /could not start the macOS keychain tool/.test(e.message) && /Keychain Access/.test(e.message));
  assert.equal(helperCalls.length, before + 1);
});

/* ---------------- keychain: metadata ---------------- */

test('readMeta: missing is null; corrupted or incomplete files are refused', async (t) => {
  const { home, r } = await newVault(t);
  const meta = keychain.readMeta({ home });
  assert.equal(meta.backend, 'passphrase');
  assert.equal(meta.recipient, r.recipient);
  assert.equal(meta.v, 1);
  assert.equal(keychain.readMeta({ home: path.join(home, 'nowhere') }), null);

  const metaFile = store.paths({ home }).metaFile;
  const bad = [
    'not json',
    '',
    'null',
    JSON.stringify({ v: 1, backend: 'floppy', recipient: r.recipient }),
    JSON.stringify({ v: 1, backend: 'passphrase', recipient: 'not-a-recipient' }),
    JSON.stringify({ v: 1, backend: 'passphrase' }),
  ];
  for (const text of bad) {
    fs.writeFileSync(metaFile, text);
    assert.throws(() => keychain.readMeta({ home }), (e) => e.code === 'ZN_LOCKED' && /keychain\.json is corrupted/.test(e.message), text);
  }
});

/* ---------------- keychain: passphrase backend ---------------- */

test('initIdentity creates the files, 0600, and never writes the identity in clear', async (t) => {
  const { home, r } = await newVault(t);
  const p = store.paths({ home });
  assert.equal(r.backend, 'passphrase');
  assert.match(r.identity, /^AGE-SECRET-KEY-1/);
  for (const f of [p.identityFile, p.metaFile]) {
    assert.ok(fs.existsSync(f));
    if (POSIX) assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(f).toString('latin1').includes(r.identity));
  }
});

test('initIdentity refuses to overwrite an existing vault and keeps the old identity', async (t) => {
  const { home, r } = await newVault(t);
  await assert.rejects(() => keychain.initIdentity({ home, backend: 'passphrase', passphrase: PASS, workFactor: WF }),
    (e) => e.code === 'ZN_POLICY_DENIED' && /already initialised/.test(e.message));
  assert.equal(await keychain.loadIdentity({ home, passphrase: PASS }), r.identity);
});

test('loadIdentity: not initialised, missing or wrong passphrase, missing identity file', async (t) => {
  const home = tmpHome(t);
  await assert.rejects(() => keychain.loadIdentity({ home }), (e) => e.code === 'ZN_NOT_FOUND' && /not initialised/.test(e.message));

  const v = await newVault(t);
  await assert.rejects(() => keychain.loadIdentity({ home: v.home }), (e) => e.code === 'ZN_LOCKED' && /passphrase required/.test(e.message));
  await assert.rejects(() => keychain.loadIdentity({ home: v.home, passphrase: 123 }), (e) => e.code === 'ZN_LOCKED');
  await assert.rejects(() => keychain.loadIdentity({ home: v.home, passphrase: 'a-wrong-fake-passphrase' }), (e) => {
    assert.equal(e.code, 'ZN_LOCKED');
    assert.match(e.message, /wrong passphrase/);
    assert.doesNotMatch(e.message, /a-wrong-fake-passphrase|AGE-SECRET-KEY/);
    return true;
  });

  fs.rmSync(store.paths({ home: v.home }).identityFile);
  await assert.rejects(() => keychain.loadIdentity({ home: v.home, passphrase: PASS }), (e) => e.code === 'ZN_NOT_FOUND' && /identity\.age missing/.test(e.message));
});

test('loadIdentity: a truncated or garbage identity.age is reported as a damaged file', async (t) => {
  const { home } = await newVault(t);
  const f = store.paths({ home }).identityFile;
  const good = fs.readFileSync(f);
  fs.writeFileSync(f, good.subarray(0, good.length - 10));
  await assert.rejects(() => keychain.loadIdentity({ home, passphrase: PASS }), (e) => e.code === 'ZN_LOCKED' && /looks damaged/.test(e.message));
  fs.writeFileSync(f, 'garbage');
  await assert.rejects(() => keychain.loadIdentity({ home, passphrase: PASS }), (e) => e.code === 'ZN_LOCKED');
});

test('loadIdentity: an identity that does not match keychain.json is refused', async (t) => {
  const { home } = await newVault(t);
  const other = await store.generateIdentity();
  const metaFile = store.paths({ home }).metaFile;
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  meta.recipient = other.recipient;
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  await assert.rejects(() => keychain.loadIdentity({ home, passphrase: PASS }), (e) => e.code === 'ZN_LOCKED' && /does not match/.test(e.message));
});

test('storeIdentity validates the identity and the passphrase', async (t) => {
  const home = tmpHome(t);
  await assert.rejects(() => keychain.storeIdentity('not-an-identity', { home, backend: 'passphrase', passphrase: PASS }),
    (e) => e.code === 'ZN_POLICY_DENIED' && /not an age X25519 identity/.test(e.message));
  await assert.rejects(() => keychain.storeIdentity(undefined, { home, backend: 'passphrase', passphrase: PASS }), (e) => e.code === 'ZN_POLICY_DENIED');
  const { identity } = await store.generateIdentity();
  for (const bad of [undefined, null, 42, 'short', 'x'.repeat(keychain.MIN_PASSPHRASE - 1)]) {
    await assert.rejects(() => keychain.storeIdentity(identity, { home, backend: 'passphrase', passphrase: bad, workFactor: WF }),
      (e) => e.code === 'ZN_POLICY_DENIED' && /at least 12 characters/.test(e.message));
  }
  assert.ok(!fs.existsSync(store.paths({ home }).identityFile));
  // exactly the minimum length is accepted
  const ok = 'x'.repeat(keychain.MIN_PASSPHRASE);
  assert.equal(await keychain.storeIdentity(identity, { home, backend: 'passphrase', passphrase: ok, workFactor: WF }), 'passphrase');
  assert.ok(fs.existsSync(store.paths({ home }).identityFile));
});

test('deleteIdentity removes the passphrase files and is safe to repeat', async (t) => {
  const { home } = await newVault(t);
  const p = store.paths({ home });
  await keychain.deleteIdentity({ home });
  assert.ok(!fs.existsSync(p.identityFile));
  assert.ok(!fs.existsSync(p.metaFile));
  await assert.doesNotReject(() => keychain.deleteIdentity({ home, backend: 'passphrase' }));
  assert.equal(keychain.readMeta({ home }), null);
});

/* ---------------- keychain: native backends, stubbed ---------------- */

test('native backend (stub): init, load, mismatch and missing entry', async (t) => {
  const be = memoryBackend();
  stubNative(t, 'libsecret', be);
  const home = tmpHome(t);
  const r = await keychain.initIdentity({ home, backend: 'libsecret' });
  assert.equal(r.backend, 'libsecret');
  assert.equal(be.m.value, r.identity);
  assert.equal(fs.existsSync(store.paths({ home }).identityFile), false);
  assert.equal(await keychain.loadIdentity({ home }), r.identity);

  const other = await store.generateIdentity();
  be.m.value = other.identity;
  await assert.rejects(() => keychain.loadIdentity({ home }), (e) => e.code === 'ZN_LOCKED' && /does not match/.test(e.message));

  be.m.value = null;
  await assert.rejects(() => keychain.loadIdentity({ home }), (e) => e.code === 'ZN_NOT_FOUND' && /libsecret keychain/.test(e.message));
});

test('native backend (stub): a keychain that drops the item fails before the vault is recorded', async (t) => {
  stubNative(t, 'macos', { store() { /* silently drops it */ }, load() { return null; }, remove() { return false; } });
  const home = tmpHome(t);
  await assert.rejects(() => keychain.initIdentity({ home, backend: 'macos' }),
    (e) => e.code === 'ZN_LOCKED' && /did not return the stored identity/.test(e.message));
  assert.equal(keychain.readMeta({ home }), null);
});

test('native backend (stub): deleteIdentity asks the backend to remove the entry', async (t) => {
  const be = memoryBackend();
  stubNative(t, 'windows', be);
  const home = tmpHome(t);
  await keychain.initIdentity({ home, backend: 'windows' });
  await keychain.deleteIdentity({ home });
  assert.equal(be.m.removed, 1);
  assert.equal(be.m.value, null);
  assert.equal(keychain.readMeta({ home }), null);
});

/* ---------------- audit log ---------------- */

const KEY = 'ab'.repeat(32);

function logFile(t) {
  return path.join(tmpHome(t), 'audit.jsonl');
}

test('audit.append: a missing or short key is refused and nothing is written', (t) => {
  const file = logFile(t);
  for (const key of [undefined, '', 'abcd', Buffer.alloc(8)]) {
    assert.throws(() => audit.append({ mode: 'env' }, { file, key }), /audit key missing/);
  }
  assert.equal(fs.existsSync(file), false);
});

test('audit.append chains records and accepts a Buffer key', (t) => {
  const file = logFile(t);
  const a = audit.append({ mode: 'env', decision: 'allow', secret: 'FAKE_NAME' }, { file, key: Buffer.from(KEY, 'hex') });
  const b = audit.append({ mode: 'file', decision: 'deny' }, { file, key: KEY });
  assert.equal(a.seq, 1);
  assert.equal(a.prev, audit.GENESIS);
  assert.equal(b.seq, 2);
  assert.equal(b.prev, a.mac);
  assert.deepEqual(audit.verify({ file, key: KEY }), { ok: true, records: 2 });
});

test('audit.append finds the last record even when it is longer than the first read', (t) => {
  const file = logFile(t);
  audit.append({ mode: 'env' }, { file, key: KEY });
  // a long last line: the tail reader must grow its window
  const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  rec.pad = 'x'.repeat(10000);
  fs.writeFileSync(file, JSON.stringify(rec) + '\n\n\n');
  const next = audit.append({ mode: 'env' }, { file, key: KEY });
  assert.equal(next.seq, 2);
  assert.equal(next.prev, rec.mac);
});

test('audit.verify: missing file is empty and valid; wrong key, edits, gaps and junk are detected', (t) => {
  const file = logFile(t);
  assert.deepEqual(audit.verify({ file, key: KEY }), { ok: true, records: 0 });
  for (let i = 0; i < 3; i++) audit.append({ mode: 'env', decision: 'allow' }, { file, key: KEY });
  assert.deepEqual(audit.verify({ file, key: KEY }), { ok: true, records: 3 });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');

  const wrongKey = audit.verify({ file, key: 'cd'.repeat(32) });
  assert.equal(wrongKey.ok, false);
  assert.equal(wrongKey.error, 'bad mac');
  assert.equal(wrongKey.line, 1);

  const edited = lines.slice();
  edited[1] = edited[1].replace('"allow"', '"deny"');
  fs.writeFileSync(file, edited.join('\n') + '\n');
  assert.deepEqual(audit.verify({ file, key: KEY }), { ok: false, records: 1, line: 2, error: 'bad mac' });

  fs.writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n'); // a record removed
  const gap = audit.verify({ file, key: KEY });
  assert.equal(gap.ok, false);
  assert.ok(gap.error === 'broken chain' || gap.error === 'bad sequence');

  fs.writeFileSync(file, lines[0] + '\n{not json\n');
  assert.deepEqual(audit.verify({ file, key: KEY }), { ok: false, records: 1, line: 2, error: 'unparseable record' });

  const noMac = JSON.parse(lines[0]);
  delete noMac.mac;
  fs.writeFileSync(file, JSON.stringify(noMac) + '\n');
  assert.equal(audit.verify({ file, key: KEY }).error, 'bad mac');
});

test('audit.verify reports a real read error instead of hiding it', (t) => {
  const dir = tmpHome(t);
  assert.throws(() => audit.verify({ file: dir, key: KEY }), (e) => e.code === 'EISDIR' || e.code === 'EPERM' || e.code === 'EACCES');
});

test('audit.sanitize drops unknown fields, redacts known values and never keeps them', () => {
  const known = ['fake-secret-value-12345'];
  const out = audit.sanitize({
    secret: 'FAKE_NAME', mode: 'weird', decision: 'maybe', agent: 'agent one', host: 'https://user@Example.COM/path',
    argv0: '/usr/bin/tool --flag', reason: 'fake-secret-value-12345', extra: 'dropped', tool: '',
  }, known);
  assert.equal(out.secret, 'FAKE_NAME');
  assert.equal(out.mode, 'other');
  assert.equal(out.decision, 'other');
  assert.equal(out.agent, '[invalid]');
  assert.equal(out.host, 'example.com');
  assert.equal(out.argv0, 'tool');
  assert.equal(out.reason, '[redacted]');
  assert.equal('extra' in out, false);
  assert.equal('tool' in out, false);
  assert.deepEqual(audit.sanitize(null), {});
});

test('audit.read: durations, dates, limit, skipped junk and bad since', (t) => {
  const file = logFile(t);
  assert.deepEqual(audit.read({ file }), []);
  for (let i = 0; i < 4; i++) audit.append({ mode: 'env', decision: 'allow' }, { file, key: KEY });
  fs.appendFileSync(file, 'junk line\n');
  const text = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && l !== 'junk line');
  const old = JSON.parse(text[0]);
  old.ts = new Date(Date.now() - 3 * 86400000).toISOString();
  fs.writeFileSync(file, [JSON.stringify(old)].concat(text.slice(1), ['junk line']).join('\n') + '\n');

  assert.equal(audit.read({ file }).length, 4);
  assert.equal(audit.read({ file, since: '1d' }).length, 3);
  assert.equal(audit.read({ file, since: '2h' }).length, 3);
  assert.equal(audit.read({ file, since: '30m' }).length, 3);
  assert.equal(audit.read({ file, since: '90s' }).length, 3);
  assert.equal(audit.read({ file, since: new Date(Date.now() - 86400000) }).length, 3);
  assert.equal(audit.read({ file, since: Date.now() - 86400000 }).length, 3);
  assert.equal(audit.read({ file, since: new Date(Date.now() - 86400000).toISOString() }).length, 3);
  assert.equal(audit.read({ file, since: '' }).length, 4);
  assert.deepEqual(audit.read({ file, limit: 2 }).map((e) => e.seq), [3, 4]);
  assert.throws(() => audit.read({ file, since: 'yesterday-ish' }), /invalid since/);
  for (const ev of audit.read({ file })) assert.ok(!('mac' in ev) && !('prev' in ev));
});

test('audit.read defaults to the audit file of ZN_HOME', (t) => {
  const home = tmpHome(t);
  withEnv(t, { ZN_HOME: home });
  assert.deepEqual(audit.read({}), []);
  audit.append({ mode: 'unlock' }, { file: store.paths().auditFile, key: KEY });
  assert.equal(audit.read({}).length, 1);
});

test('environment variables are back to their initial values', () => {
  for (const k of Object.keys(INITIAL_ENV)) assert.equal(process.env[k], INITIAL_ENV[k], k);
});
