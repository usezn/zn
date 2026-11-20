'use strict';
/*
 * Vault writes on a full disk (ENOSPC, simulated in-process by failing fs.writeSync on every file descriptor above
 * stdio). secret rm, secret import, env shadow and lock fail with the plain disk-full sentence, leave the vault and
 * the .env file as they were, leave no temporary file, and do not grow audit.jsonl. A write that succeeds still
 * audits what it did.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-vault-disk-'));
process.env.ZN_HOME = path.join(HOME, '.zn');
process.env.ZN_KEYCHAIN_BACKEND = 'passphrase';

const keychain = require('../lib/vault/keychain');
const daemon = require('../lib/vault/daemon');
const { createClient } = require('../lib/vault/client');
const { dispatch } = require('../lib/broker/cli');

const ZN_HOME = process.env.ZN_HOME;
const AUDIT = path.join(ZN_HOME, 'audit.jsonl');
const DISK_FULL = /The disk that holds the vault is full\. Free some space, then try again\./;
const realWriteSync = fs.writeSync;

let srv = null;
let vault = null;

// Example values only: fictitious, labelled, and never shaped like a real credential.
const fake = (tag) => 'example-' + tag + '-0123456789abcdef';

// quota: the Linux shape of a full quota (EDQUOT, errno 122), which Node reports as code UNKNOWN.
function diskFull(on, quota = false) {
  fs.writeSync = on
    ? (fd, ...rest) => {
      if (fd > 2) {
        throw quota
          ? Object.assign(new Error('UNKNOWN: unknown error, write'), { code: 'UNKNOWN', errno: -122, syscall: 'write' })
          : Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' });
      }
      return realWriteSync.call(fs, fd, ...rest);
    }
    : realWriteSync;
}

function sink() {
  let text = '';
  return { write: (s) => { text += s; return true; }, get text() { return text; } };
}

// The broker command line, in-process, on the unlocked vault. io.human skips the terminal check.
async function zn(group, args, cwd) {
  const stdout = sink();
  const stderr = sink();
  const rc = await dispatch(group, args, { human: true, vault, cwd, stdout, stderr, confirm: async () => true });
  return { rc, out: stdout.text, err: stderr.text };
}

function auditSize() {
  return fs.existsSync(AUDIT) ? fs.statSync(AUDIT).size : 0;
}

// Temporary files zn writes next to its files (name.<pid>.<hex>.tmp or .zn-tmp).
function leftovers(dir) {
  const found = [];
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) found.push(...leftovers(p));
    else if (/\.tmp$|zn-tmp/.test(n.name)) found.push(p);
  }
  return found;
}

async function names() {
  return (await vault.listSecrets()).map((s) => s.name);
}

test.before(async () => {
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  srv = await daemon.serve({ identity: created.identity, ttlMs: 600000, idleMs: 600000, confirm: async () => true, teamSyncMs: 0 });
  vault = createClient({});
  await vault.setSecret('KEEP_TOKEN', fake('keep'), { mode: 'env' });
  await vault.setSecret('OLD_TOKEN', fake('old'), { mode: 'env' });
});

test.after(async () => {
  diskFull(false);
  if (vault) vault.close();
  if (srv) await srv.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('secret rm on a full disk: plain sentence, the secret stays, audit does not grow', async () => {
  const before = auditSize();
  const namesBefore = await names();
  diskFull(true);
  const r = await zn('secret', ['rm', 'OLD_TOKEN'], HOME);
  diskFull(false);
  assert.notEqual(r.rc, 0, r.err);
  assert.match(r.err, DISK_FULL);
  assert.doesNotMatch(r.err, /internal error|ENOSPC|no space left/);
  assert.deepEqual(await names(), namesBefore, 'the vault still holds the secret');
  assert.equal(auditSize(), before, 'audit.jsonl did not grow');
  assert.deepEqual(leftovers(ZN_HOME), []);
});

test('secret rm on a full quota: the same plain sentence as a full disk', async () => {
  const before = auditSize();
  const namesBefore = await names();
  diskFull(true, true);
  const r = await zn('secret', ['rm', 'KEEP_TOKEN'], HOME);
  diskFull(false);
  assert.notEqual(r.rc, 0, r.err);
  assert.match(r.err, /Your disk quota is used up, so the vault cannot be written\. Free some space, then try again\./);
  assert.doesNotMatch(r.err, /internal error|UNKNOWN|errno/);
  assert.deepEqual(await names(), namesBefore, 'the vault still holds the secret');
  assert.equal(auditSize(), before, 'audit.jsonl did not grow');
});

test('secret import on a full disk: plain sentence, nothing stored, .env unchanged, audit does not grow', async () => {
  const envFile = path.join(HOME, 'import.env');
  const text = 'IMPORT_TOKEN=' + fake('import') + '\n';
  fs.writeFileSync(envFile, text);
  const before = auditSize();
  diskFull(true);
  const r = await zn('secret', ['import', envFile], HOME);
  diskFull(false);
  assert.notEqual(r.rc, 0, r.err);
  assert.match(r.err, DISK_FULL);
  assert.doesNotMatch(r.err, /internal error|ENOSPC|no space left/);
  assert.equal(fs.readFileSync(envFile, 'utf8'), text);
  assert.equal((await names()).includes('IMPORT_TOKEN'), false, 'no secret was stored');
  assert.equal(auditSize(), before, 'audit.jsonl did not grow');
  assert.deepEqual(leftovers(HOME), []);
});

test('env shadow on a full disk: plain sentence, .env and vault unchanged, audit does not grow', async () => {
  const envFile = path.join(HOME, 'shadow.env');
  const text = 'SHADOW_TOKEN=' + fake('shadow') + '\n';
  fs.writeFileSync(envFile, text);
  const before = auditSize();
  const namesBefore = await names();
  diskFull(true);
  const r = await zn('env', ['shadow', envFile], HOME);
  diskFull(false);
  assert.notEqual(r.rc, 0, r.err);
  assert.match(r.err, DISK_FULL);
  assert.doesNotMatch(r.err, /internal error|ENOSPC|no space left/);
  assert.equal(fs.readFileSync(envFile, 'utf8'), text, 'the .env file is unchanged');
  assert.deepEqual(await names(), namesBefore, 'no backup or secret was added to the vault');
  assert.equal(auditSize(), before, 'audit.jsonl did not grow');
  assert.deepEqual(leftovers(HOME), []);
});

test('lock on a full disk: the vault stays unlocked and the lock is not audited', async () => {
  const before = auditSize();
  diskFull(true);
  let err = null;
  try { await vault.lock(); } catch (e) { err = e; }
  diskFull(false);
  assert.ok(err, 'lock fails');
  assert.match(String(err.message), DISK_FULL);
  assert.equal(auditSize(), before, 'audit.jsonl did not grow');
  assert.equal(await vault.isUnlocked(), true, 'the vault is still unlocked');
});

test('the same commands succeed once the disk has room, and their writes are audited', async () => {
  const envFile = path.join(HOME, 'shadow-ok.env');
  fs.writeFileSync(envFile, 'SHADOW_OK_TOKEN=' + fake('shadow-ok') + '\n');
  const before = auditSize();
  const r = await zn('env', ['shadow', envFile], HOME);
  assert.equal(r.rc, 0, r.err);
  assert.match(fs.readFileSync(envFile, 'utf8'), /SHADOW_OK_TOKEN/);
  assert.equal((await names()).includes('SHADOW_OK_TOKEN'), true);
  assert.ok(auditSize() > before, 'the successful shadow is audited');
});
