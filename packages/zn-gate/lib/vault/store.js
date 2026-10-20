'use strict';
/**
 * Encrypted store on disk. Everything secret is an age file; nothing is
 * ever written in clear.
 *
 *   ~/.zn/                       (0700)   override with ZN_HOME
 *     vault/                     (0700)
 *       secrets.age              named secrets + local audit key
 *       <project-hash>.age       token map of one project (detected values)
 *       identity.age             age identity behind a passphrase (only when
 *                                no OS keychain is available)
 *       keychain.json            backend name + age recipient (public key)
 *     run/                       (0700)   daemon socket and session key
 *     audit.jsonl                (0600)   HMAC-chained audit log
 *
 * Files are written atomically (temporary file + rename) with mode 0600.
 * On POSIX the directories are checked to be owned by the current user and
 * closed to group and others; anything else is refused. On Windows each
 * directory and file gets an owner-only ACL (icacls, inheritance removed);
 * when that fails outside the user profile (a custom ZN_HOME such as C:/zn,
 * where inherited ACLs can let other local users in) nothing is written.
 *
 * Encryption: age X25519 recipients (age-encryption, by Filippo Valsorda);
 * scrypt recipients for the passphrase fallback. No custom cryptography.
 */

const fs = require('fs');
const { trimTrailing } = require('../linear-text');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { CODES, znError } = require('../errors');

const PROJECT_FILE_RE = /^[0-9a-f]{32}\.age$/;
const STALE_DAYS = 30;

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

function znHome(opts) {
  if (opts && opts.home) return path.resolve(opts.home);
  if (process.env.ZN_HOME) return path.resolve(process.env.ZN_HOME);
  return path.join(os.homedir(), '.zn');
}

function paths(opts) {
  const home = znHome(opts);
  const vaultDir = path.join(home, 'vault');
  const runDir = path.join(home, 'run');
  return {
    home,
    vaultDir,
    runDir,
    secretsFile: path.join(vaultDir, 'secrets.age'),
    identityFile: path.join(vaultDir, 'identity.age'),
    metaFile: path.join(vaultDir, 'keychain.json'),
    auditFile: path.join(home, 'audit.jsonl'),
  };
}

function normalizeProject(project) {
  const p = String(project == null ? '' : project);
  if (path.isAbsolute(p)) {
    let r = path.resolve(p);
    if (process.platform === 'win32') r = r.toLowerCase();
    return trimTrailing(r, '\\/') || r;
  }
  return p;
}

/** Stable, non-reversible file key for a project (hash of its path or id). */
function projectKey(project) {
  return crypto.createHash('sha256').update('zn-project-v1\0' + normalizeProject(project)).digest('hex').slice(0, 32);
}

function projectFile(project, opts) {
  return path.join(paths(opts).vaultDir, projectKey(project) + '.age');
}

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

const aclDone = new Set();

function winSystemExe(name) {
  const root = process.env.SystemRoot || process.env.windir || 'C:/Windows';
  return path.win32.join(root, 'System32', name);
}

/** SID of the current user, from `whoami /user` (no name quoting issues). */
function currentUserSid() {
  const out = childProcess.execFileSync(winSystemExe('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const m = /S-1-\d+(?:-\d+)+/.exec(String(out));
  if (!m) throw new Error('could not read the user SID');
  return m[0];
}

function insideUserProfile(target) {
  const norm = (p) => path.resolve(p).toLowerCase();
  const rel = path.relative(norm(os.homedir()), norm(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Windows: make `target` owner-only. Inheritance is removed and only the
 * current user's SID gets full control (SYSTEM is not granted: the daemon and
 * Credential Manager both run as the user). Returns true on success; on
 * failure it warns and returns false.
 */
function restrictToOwner(target, isDir) {
  if (aclDone.has(target)) return true;
  try {
    const sid = currentUserSid();
    const perm = '*' + sid + (isDir ? ':(OI)(CI)F' : ':F');
    childProcess.execFileSync(winSystemExe('icacls.exe'), [target, '/inheritance:r', '/grant:r', perm], {
      windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    aclDone.add(target);
    return true;
  } catch (err) {
    process.stderr.write('[zn] warning: could not restrict ' + target + ' to your user (icacls: ' +
      String((err && err.message) || err).split('\n')[0].slice(0, 120) + ').\n');
    return false;
  }
}

/** Windows: owner-only ACL, or refuse when it failed outside the user profile. */
function protectWindows(target, isDir) {
  if (restrictToOwner(target, isDir)) return;
  if (!insideUserProfile(target)) {
    throw znError(CODES.POLICY_DENIED, 'could not restrict ' + target + ' to your user and it is outside your user ' +
      'profile; refusing to store secrets there. Use a folder inside your profile (unset ZN_HOME) or fix the permissions.');
  }
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') { protectWindows(dir, true); return; }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw znError(CODES.POLICY_DENIED, 'not a directory: ' + dir);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw znError(CODES.POLICY_DENIED, 'directory is owned by another user: ' + dir);
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

function ensureLayout(opts) {
  const p = paths(opts);
  ensurePrivateDir(p.home);
  ensurePrivateDir(p.vaultDir);
  ensurePrivateDir(p.runDir);
  return p;
}

/* ------------------------------------------------------------------ */
/* age                                                                 */
/* ------------------------------------------------------------------ */

let agePromise = null;
function loadAge() {
  if (!agePromise) {
    // Node 18 has WebCrypto but not as a global; age-encryption expects one.
    if (!globalThis.crypto || !globalThis.crypto.getRandomValues) {
      globalThis.crypto = require('crypto').webcrypto;
    }
    agePromise = import('age-encryption');
  }
  return agePromise;
}

async function generateIdentity() {
  const age = await loadAge();
  const identity = await age.generateX25519Identity();
  const recipient = await age.identityToRecipient(identity);
  return { identity, recipient };
}

async function recipientOf(identity) {
  const age = await loadAge();
  return age.identityToRecipient(identity);
}

async function encryptTo(recipient, plaintext) {
  const age = await loadAge();
  const e = new age.Encrypter();
  e.addRecipient(recipient);
  return e.encrypt(plaintext);
}

async function decryptWith(identity, ciphertext) {
  const age = await loadAge();
  const d = new age.Decrypter();
  d.addIdentity(identity);
  return d.decrypt(ciphertext, 'text');
}

async function encryptWithPassphrase(passphrase, plaintext, workFactor) {
  const age = await loadAge();
  const e = new age.Encrypter();
  e.setPassphrase(passphrase);
  if (workFactor) e.setScryptWorkFactor(workFactor);
  return e.encrypt(plaintext);
}

async function decryptWithPassphrase(passphrase, ciphertext) {
  const age = await loadAge();
  const d = new age.Decrypter();
  d.addPassphrase(passphrase);
  return d.decrypt(ciphertext, 'text');
}

/* ------------------------------------------------------------------ */
/* Atomic private files                                                */
/* ------------------------------------------------------------------ */

function writePrivateFile(file, data) {
  ensurePrivateDir(path.dirname(file));
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (process.platform === 'win32') protectWindows(tmp, false);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    throw err;
  }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function readPrivateFile(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  if (!st.isFile() || st.isSymbolicLink()) throw znError(CODES.POLICY_DENIED, 'not a regular file: ' + file);
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw znError(CODES.POLICY_DENIED, 'file is owned by another user: ' + file);
  }
  return fs.readFileSync(file);
}

/** Read and decrypt a JSON age file; null when it does not exist. */
async function readEncrypted(file, identity) {
  const buf = readPrivateFile(file);
  if (buf === null) return null;
  let text;
  try {
    text = await decryptWith(identity, new Uint8Array(buf));
    return JSON.parse(text);
  } catch (err) {
    throw znError(CODES.LOCKED, 'vault file ' + path.basename(file) + ' is corrupted or was encrypted to another key (' +
      String((err && err.message) || err).slice(0, 80) + '). Restore it from a backup; zn will not read or replace it.');
  }
}

/** true when this ZN_HOME already has history: an audit log or project maps. */
function hasPriorState(opts) {
  const p = paths(opts);
  try { if (fs.statSync(p.auditFile).size > 0) return true; } catch (err) { /* none */ }
  try { return fs.readdirSync(p.vaultDir).some((n) => PROJECT_FILE_RE.test(n)); } catch (err) { return false; }
}

/** Encrypt JSON to the recipient and write it atomically (0600). */
async function writeEncrypted(file, data, recipient) {
  const ct = await encryptTo(recipient, JSON.stringify(data));
  writePrivateFile(file, Buffer.from(ct));
}

/* ------------------------------------------------------------------ */
/* Housekeeping                                                        */
/* ------------------------------------------------------------------ */

/** Delete project token maps unused for `days` (default 30). Returns count. */
function pruneStale(opts) {
  const days = (opts && opts.days) || STALE_DAYS;
  const dir = paths(opts).vaultDir;
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (err) { return 0; }
  const limit = Date.now() - days * 86400000;
  for (const n of names) {
    if (!PROJECT_FILE_RE.test(n)) continue;
    const f = path.join(dir, n);
    try {
      if (fs.statSync(f).mtimeMs < limit) { fs.unlinkSync(f); removed++; }
    } catch (err) { /* ignore */ }
  }
  return removed;
}

/** Forget one project's token map (zn-gate scrub forget). */
function forgetProject(project, opts) {
  try { fs.unlinkSync(projectFile(project, opts)); return true; } catch (err) { return false; }
}

function touch(file) {
  const now = new Date();
  try { fs.utimesSync(file, now, now); } catch (err) { /* ignore */ }
}

module.exports = {
  znHome,
  paths,
  projectKey,
  projectFile,
  normalizeProject,
  ensureLayout,
  ensurePrivateDir,
  loadAge,
  generateIdentity,
  recipientOf,
  encryptTo,
  decryptWith,
  encryptWithPassphrase,
  decryptWithPassphrase,
  readEncrypted,
  writeEncrypted,
  hasPriorState,
  writePrivateFile,
  readPrivateFile,
  pruneStale,
  forgetProject,
  touch,
  STALE_DAYS,
};
