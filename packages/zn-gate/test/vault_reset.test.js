'use strict';
// zn vault reset: the way out of a lost passphrase. Everything runs in a temporary ZN_HOME.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV = ['HOME', 'USERPROFILE', 'ZN_HOME', 'ZN_KEYCHAIN_BACKEND'];
const daemon = require('../lib/vault/daemon');
const store = require('../lib/vault/store');
const keychain = require('../lib/vault/keychain');
const reset = require('../lib/vault/reset');
const policy = require('../lib/hooks/policy');

const OLD = 'old pass phrase for the test vault';
const NEW = 'new pass phrase for the test vault';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return false; } };

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-reset-'));
  const znHome = path.join(home, '.zn');
  const saved = {};
  const env = { HOME: home, USERPROFILE: home, ZN_HOME: znHome, ZN_KEYCHAIN_BACKEND: 'passphrase' };
  for (const k of ENV) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  let pid = 0;
  t.after(async () => {
    try { await daemon.lock({}); } catch (err) { /* already locked */ }
    for (let i = 0; i < 100 && pid && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return {
    znHome,
    /** A real vault: created by unlock, then locked and the daemon gone. */
    async makeVault(pass) {
      const u = await daemon.unlock({ passphrase: pass, workFactor: 10 });
      pid = u.pid;
      await daemon.lock({});
      for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      fs.writeFileSync(path.join(store.paths({}).vaultDir, 'a'.repeat(32) + '.age'), 'project token map');
    },
  };
}

const person = (extra) => Object.assign({ stdin: { isTTY: true }, env: {}, ancestry: () => null, out: () => {} }, extra);
const snapshot = (dir) => {
  const acc = {};
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f); else acc[path.relative(dir, f)] = fs.readFileSync(f).toString('hex'); } };
  walk(dir);
  return acc;
};

test('without a terminal it refuses and changes nothing', async (t) => {
  const s = setup(t);
  await s.makeVault(OLD);
  const before = snapshot(s.znHome);
  await assert.rejects(reset.resetVault({}, person({ stdin: { isTTY: false } })), /interactive terminal/);
  assert.deepEqual(snapshot(s.znHome), before);
});

test('run by an AI agent it refuses and changes nothing', async (t) => {
  const s = setup(t);
  await s.makeVault(OLD);
  const before = snapshot(s.znHome);
  for (const env of [{ CLAUDECODE: '1' }, { CLAUDECODE: '' }, { CODEX_SANDBOX: '1' }, { ZN_AGENT: 'x' }]) {
    await assert.rejects(reset.resetVault({}, person({ env, ask: async () => reset.PHRASE })), /not by an AI agent/);
  }
  await assert.rejects(reset.resetVault({}, person({ ancestry: () => 'claude', ask: async () => reset.PHRASE })), /not by an AI agent/);
  assert.deepEqual(snapshot(s.znHome), before);
});

test('a wrong confirmation phrase changes nothing', async (t) => {
  const s = setup(t);
  await s.makeVault(OLD);
  const before = snapshot(s.znHome);
  const said = [];
  assert.equal(await reset.resetVault({}, person({ ask: async () => 'yes', out: (l) => said.push(l) })), 1);
  assert.deepEqual(snapshot(s.znHome), before);
  assert.ok(said.includes(reset.CANCELLED));
});

test('the prompt warns that values are lost and names the commands to store them again', async (t) => {
  const s = setup(t);
  await s.makeVault(OLD);
  const said = [];
  let asked = '';
  await reset.resetVault({}, person({ ask: async (q) => { asked = q; return reset.PHRASE; }, out: (l) => said.push(l) }));
  const text = said.join('\n');
  assert.match(text, /Every secret stored in it is lost/);
  assert.match(text, /zn env shadow/);
  assert.match(text, /zn secret set NAME/);
  assert.match(text, /zn unlock/);
  assert.match(asked, /type "reset my vault"/);
});

test('a confirmed reset backs up the old vault and a new empty vault works', async (t) => {
  const s = setup(t);
  await s.makeVault(OLD);
  const p = store.paths({});
  const before = snapshot(s.znHome);
  for (const rel of ['audit.jsonl', path.join('vault', 'secrets.age'), path.join('vault', 'identity.age'), path.join('vault', 'keychain.json')]) assert.ok(before[rel], rel);

  assert.equal(await reset.resetVault({}, person({ ask: async () => '  Reset My Vault ' })), 0);

  const backups = fs.readdirSync(s.znHome).filter((n) => /^vault-backup-\d{8}-\d{6}/.test(n));
  assert.equal(backups.length, 1);
  const saved = snapshot(path.join(s.znHome, backups[0]));
  for (const [rel, hex] of Object.entries(before)) {
    if (rel.startsWith('run' + path.sep)) continue;
    assert.equal(saved[rel], hex, rel + ' is in the backup, byte for byte');
  }
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(s.znHome, backups[0])).mode & 0o077, 0, 'backup folder is private');

  assert.equal(fs.existsSync(p.secretsFile), false);
  assert.equal(fs.existsSync(p.auditFile), false);
  assert.equal(keychain.readMeta({}), null);
  assert.equal(store.hasPriorState({}), false);

  // The backup still opens with the old passphrase; the live vault is new and empty.
  const oldId = await store.decryptWithPassphrase(OLD, new Uint8Array(fs.readFileSync(path.join(s.znHome, backups[0], 'vault', 'identity.age'))));
  assert.match(oldId, /^AGE-SECRET-KEY-1/);
  const u = await daemon.unlock({ passphrase: NEW, workFactor: 10 });
  assert.equal(u.created, true);
  await daemon.lock({});
  for (let i = 0; i < 100 && alive(u.pid); i++) await new Promise((r) => setTimeout(r, 100));
  const id = await keychain.loadIdentity({ passphrase: NEW });
  assert.notEqual(id, oldId);
  assert.deepEqual((await store.readEncrypted(p.secretsFile, id)).secrets, {});
});

test('a second reset in the same second does not overwrite the first backup', async (t) => {
  const s = setup(t);
  const now = new Date(2026, 9, 19, 12, 0, 0);
  await s.makeVault(OLD);
  await reset.resetVault({}, person({ ask: async () => reset.PHRASE, now }));
  await s.makeVault(NEW);
  await reset.resetVault({}, person({ ask: async () => reset.PHRASE, now }));
  assert.equal(fs.readdirSync(s.znHome).filter((n) => n.startsWith('vault-backup-')).length, 2);
});

test('inside a Team organization it refuses and leaves the policy and the vault intact', async (t) => {
  const s = setup(t);
  await s.makeVault(OLD);
  fs.writeFileSync(path.join(s.znHome, 'team.json'), JSON.stringify({ v: 1, org: 'Example Org' }));
  fs.writeFileSync(path.join(s.znHome, 'org-policy.json'), '{"v":1}');
  const before = snapshot(s.znHome);
  assert.equal(await reset.resetVault({}, person({ ask: async () => reset.PHRASE })), 1);
  assert.deepEqual(snapshot(s.znHome), before);
});

test('an unlocked vault must be locked first', async (t) => {
  const s = setup(t);
  await s.makeVault(OLD);
  const before = snapshot(s.znHome);
  const orig = daemon.isRunning;
  daemon.isRunning = async () => true;
  try {
    assert.equal(await reset.resetVault({}, person({ ask: async () => reset.PHRASE })), 1);
  } finally { daemon.isRunning = orig; }
  assert.deepEqual(snapshot(s.znHome), before);
});

test('with no vault there is nothing to reset', async (t) => {
  setup(t);
  const said = [];
  assert.equal(await reset.resetVault({}, person({ out: (l) => said.push(l) })), 0);
  assert.deepEqual(said, [reset.NOTHING]);
});

test('after three failed unlocks the hint points to zn vault reset; a good unlock clears the count', (t) => {
  setup(t);
  fs.mkdirSync(path.join(process.env.ZN_HOME), { recursive: true });
  assert.equal(reset.recordUnlockFailure({}), null);
  assert.equal(reset.recordUnlockFailure({}), null);
  const tip = reset.recordUnlockFailure({});
  assert.match(tip, /zn vault reset/);
  assert.equal(tip.split('\n').length, 1, 'one line');
  reset.clearUnlockFailures({});
  assert.equal(reset.recordUnlockFailure({}), null);
});

/** The error `zn unlock` really gets for this attempt, so the test follows what lib/vault reports. */
async function unlockError(pass) {
  try { await keychain.loadIdentity({ backend: 'passphrase', passphrase: pass }); } catch (err) { return err; }
  throw new Error('loadIdentity did not fail');
}

test('only wrong passphrases count: three of them show the reset hint', async (t) => {
  const s = setup(t);
  await s.makeVault(OLD);
  for (let i = 0; i < 2; i++) {
    const err = await unlockError('not the passphrase');
    assert.equal(err.code, 'ZN_LOCKED');
    assert.equal(err.reason, keychain.WRONG_PASSPHRASE);
    assert.equal(reset.hintForUnlockError(err, {}), null);
  }
  assert.equal(reset.hintForUnlockError(await unlockError('still not it'), {}), reset.HINT);
});

test('a damaged identity file never shows the reset hint, however many times', async (t) => {
  const s = setup(t);
  await s.makeVault(OLD);
  const file = store.paths({}).identityFile;
  fs.writeFileSync(file, fs.readFileSync(file).subarray(0, 20));
  for (let i = 0; i < 4; i++) {
    const err = await unlockError(OLD);
    assert.equal(err.code, 'ZN_LOCKED', 'public code is unchanged');
    assert.notEqual(err.reason, keychain.WRONG_PASSPHRASE);
    const tip = reset.hintForUnlockError(err, {});
    assert.equal(tip, reset.UNREADABLE_HINT);
    assert.doesNotMatch(tip, /zn vault reset/);
    assert.match(tip, /troubleshooting\.md/);
  }
});

test('the error text matches the hint: wrong passphrase keeps its wording, a damaged identity file says it is damaged', async (t) => {
  const s = setup(t);
  await s.makeVault(OLD);
  const wrong = await unlockError('not the passphrase');
  assert.equal(wrong.message, 'wrong passphrase, or vault file identity.age is corrupted');
  assert.equal(wrong.reason, keychain.WRONG_PASSPHRASE);
  const file = store.paths({}).identityFile;
  fs.writeFileSync(file, fs.readFileSync(file).subarray(0, 20));
  const damaged = await unlockError(OLD);
  assert.equal(damaged.code, 'ZN_LOCKED');
  assert.notEqual(damaged.reason, keychain.WRONG_PASSPHRASE);
  assert.match(damaged.message, /identity\.age looks damaged/);
  assert.match(damaged.message, /Restore it from a backup/);
  assert.match(damaged.message, /Do not reset/);
  assert.doesNotMatch(damaged.message, /wrong passphrase/i);
  const tip = reset.hintForUnlockError(damaged, {});
  assert.equal(tip, reset.UNREADABLE_HINT);
  assert.match(tip, /Do not reset/);
  assert.doesNotMatch(tip, /zn vault reset/);
});

test('keychain and other non-passphrase errors restart the count', (t) => {
  setup(t);
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
  const wrong = Object.assign(new Error('wrong passphrase'), { code: 'ZN_LOCKED', reason: keychain.WRONG_PASSPHRASE });
  const keychainDown = Object.assign(new Error('Secret Service refused the identity'), { code: 'ZN_LOCKED' });
  assert.equal(reset.hintForUnlockError(wrong, {}), null);
  assert.equal(reset.hintForUnlockError(wrong, {}), null);
  assert.equal(reset.hintForUnlockError(keychainDown, {}), reset.UNREADABLE_HINT);
  assert.equal(reset.hintForUnlockError(wrong, {}), null, 'the count started over');
  assert.equal(reset.hintForUnlockError(wrong, {}), null);
  assert.equal(reset.hintForUnlockError(wrong, {}), reset.HINT);
});

test('the hooks stop an agent from running zn vault reset', () => {
  const OPTS = { cwd: os.tmpdir(), home: os.tmpdir(), env: {} };
  for (const cmd of ['zn vault reset', 'npx -y zn-gate vault reset', 'cd x && zn-gate  vault   reset']) {
    assert.equal(policy.adminCommand(cmd), 'vault reset', cmd);
    assert.match(policy.bashDenial(cmd, OPTS), /own terminal/, cmd);
  }
  for (const cmd of ['zn vault status', 'zn vault forget', 'echo vault reset']) assert.equal(policy.adminCommand(cmd), null, cmd);
});

test('an agent may not run zn vault passphrase, in any spelling zn vault reset is refused in', () => {
  const policy = require('../lib/hooks/policy');
  const o = { cwd: process.cwd(), home: process.cwd(), env: {} };
  for (const c of ['zn vault passphrase', 'npx -y zn-gate vault passphrase', 'echo x && zn-gate vault  passphrase']) {
    const d = policy.bashDenial(c, o);
    assert.ok(d, c);
    assert.match(String(d), /vault passphrase/);
    assert.match(String(d), /user's decision/);
  }
  assert.equal(policy.bashDenial('zn vault status', o), null);
});
