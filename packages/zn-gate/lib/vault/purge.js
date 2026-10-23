'use strict';
/**
 * `zn vault purge`: delete the vault for good, backups included.
 *
 * `zn vault reset` sets the old vault aside (a `vault-backup-*` folder) and starts empty; it
 * never deletes anything. Purge is the other operation: it lists every file it will delete (the
 * vault, its token maps, the audit log, every backup, the session key), asks the person to
 * confirm, deletes them, and checks that none is left. It never says "deleted" when something
 * remains.
 *
 * Guards, each before anything is touched:
 *   - never an AI agent. A person at a terminal types the phrase; a script (no terminal, no
 *     agent) may pass --yes instead;
 *   - this computer is not part of a zn Team organization (same reason as the reset);
 *   - the vault is locked.
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const keychain = require('./keychain');
const daemon = require('./daemon');
const tty = require('../broker/tty');
const messages = require('../messages');
const reset = require('./reset');
const policy = require('../team/policy');

const PHRASE = 'purge my vault';
const BACKUP_RE = /^vault-backup-/;

const zn = (args) => require('../zn-command').znCommand(args);

const KIND = {
  'secrets.age': 'secrets and first-use approvals',
  'identity.age': 'vault key (passphrase protected)',
  'keychain.json': 'vault settings',
};

function kindOf(rel) {
  const base = path.basename(rel);
  if (rel === 'audit.jsonl') return 'audit log';
  if (KIND[base]) return KIND[base];
  if (/^[0-9a-f]{32}\.age$/.test(base)) return 'token map of a project';
  return 'file';
}

function isRealDir(f) {
  try { return fs.lstatSync(f).isDirectory(); } catch (err) { return false; }
}

function present(f) {
  try { fs.lstatSync(f); return true; } catch (err) { return false; }
}

/** True when child is parent or lies inside it. */
function inside(parent, child) {
  const r = path.relative(parent, child);
  return r === '' || (r.split(path.sep)[0] !== '..' && !path.isAbsolute(r));
}

/** The native backend that holds a zn entry on this computer, when keychain.json cannot say; else null. */
function probeNative() {
  let b = null;
  try { b = keychain.detectBackend(); } catch (err) { return null; }
  if (!b || b === 'passphrase' || !keychain._native[b]) return null;
  try { return keychain._native[b].load() ? b : null; } catch (err) { return null; }
}

function walk(dir, acc, dirs) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (err) { return acc; }
  for (const n of names) {
    const f = path.join(dir, n);
    let st;
    try { st = fs.lstatSync(f); } catch (err) { continue; }
    if (st.isDirectory()) { if (dirs) dirs.push(f); walk(f, acc, dirs); } else acc.push(f);
  }
  return acc;
}

/**
 * Everything purge would delete: { files: [{ path, kind }], dirs: [backup folders, deepest first],
 * backend }. A symbolic link is listed as the link itself and never followed.
 */
function targets(opts) {
  const p = store.paths(opts);
  const files = reset.vaultFiles(opts).map((f) => ({ path: f.src, kind: kindOf(f.rel) }));
  const dirs = [];
  let names = [];
  try { names = fs.readdirSync(p.home); } catch (err) { /* no zn folder */ }
  for (const n of names.filter((x) => BACKUP_RE.test(x)).sort()) {
    const d = path.join(p.home, n);
    let st;
    try { st = fs.lstatSync(d); } catch (err) { continue; }
    if (!st.isDirectory()) { files.push({ path: d, kind: 'backup' }); continue; }
    for (const f of walk(d, [], dirs)) files.push({ path: f, kind: 'backup (' + n + ')', folder: d });
    dirs.push(d);
  }
  // The vault and run folders are never followed when they are a link (or anything but a folder):
  // the link itself is what goes. Inside run, only the first level, and never a folder.
  if (present(p.vaultDir) && !isRealDir(p.vaultDir)) files.push({ path: p.vaultDir, kind: 'link in place of the vault folder (only the link is deleted)' });
  if (present(p.runDir) && !isRealDir(p.runDir)) {
    files.push({ path: p.runDir, kind: 'link in place of the runtime folder (only the link is deleted)' });
  } else if (isRealDir(p.runDir)) {
    let runNames = [];
    try { runNames = fs.readdirSync(p.runDir); } catch (err) { /* unreadable */ }
    for (const n of runNames) {
      const f = path.join(p.runDir, n);
      try { if (fs.lstatSync(f).isDirectory()) continue; } catch (err) { continue; }
      files.push({ path: f, kind: n === 'session.key' ? 'session key' : 'daemon runtime file' });
    }
  }
  const fails = path.join(p.home, 'unlock-failures');
  try { if (fs.lstatSync(fails).isFile()) files.push({ path: fails, kind: 'failed-unlock counter' }); } catch (err) { /* none */ }
  let backend = null;
  let probe = null;
  // keychain.json is read only from a real vault folder; when it is damaged, ask the system backends.
  if (isRealDir(p.vaultDir)) {
    try { const m = keychain.readMeta(opts); backend = m && m.backend; } catch (err) { probe = probeNative(); }
  }
  return { files, dirs: dirs.sort((a, b) => b.length - a.length), backend, probe };
}

/**
 * The lines that say what purge deletes, grouped: one line per backup folder, one for the token
 * maps, the session key, and the keychain entry. Used by `uninstall` before its second question.
 */
function summary(t) {
  const lines = [];
  const folders = new Map();
  let maps = 0;
  for (const f of t.files) {
    if (f.folder) folders.set(f.folder, (folders.get(f.folder) || 0) + 1);
    else if (f.kind === 'token map of a project') maps++;
    else lines.push('  - ' + f.path + '  (' + f.kind + ')');
  }
  for (const [d, n] of folders) lines.push('  - ' + d + ': ' + n + ' file' + (n === 1 ? '' : 's') + ' (a backup made by `zn vault reset`)');
  if (maps) lines.push('  - ' + maps + ' token map' + (maps === 1 ? '' : 's') + ' of projects');
  if (t.backend && t.backend !== 'passphrase') lines.push('  - the vault key in your ' + t.backend + ' keychain');
  return lines;
}

/** Delete one file or link; returns true when it is gone. Never when its folder resolves outside zn's home. */
function unlinkGone(f, homeReal) {
  let dir;
  try { dir = fs.realpathSync(path.dirname(f)); } catch (err) { return !!err && err.code === 'ENOENT'; }
  if (!homeReal || !inside(homeReal, dir)) return false;
  try { fs.unlinkSync(f); } catch (err) { if (!err || err.code !== 'ENOENT') return false; }
  return true;
}

/**
 * Delete everything targets() lists. Files first, the vault key last: if a file cannot be
 * removed the key stays, so what is left still opens. Returns
 * { removed: [paths], left: [paths still there], key: 'none'|'removed'|'kept'|'unconfirmed'|'left', backend }.
 */
async function removeAll(opts) {
  const t = targets(opts);
  const removed = [];
  const left = [];
  let homeReal = null;
  try { homeReal = fs.realpathSync(store.paths(opts).home); } catch (err) { /* no zn folder */ }
  for (const f of t.files) (unlinkGone(f.path, homeReal) ? removed : left).push(f.path);
  let key = 'none';
  if (left.length) {
    key = t.backend && t.backend !== 'passphrase' ? 'kept' : 'none';
  } else if (t.backend && t.backend !== 'passphrase') {
    // Name the backend: the settings file that says which one is already gone.
    try { await keychain.deleteIdentity(Object.assign({}, opts, { backend: t.backend })); } catch (err) { /* checked below */ }
    try { key = keychain._native[t.backend].load() === null ? 'removed' : 'left'; } catch (err) { key = 'unconfirmed'; }
  }
  const p = store.paths(opts);
  for (const d of t.dirs) { try { fs.rmdirSync(d); } catch (err) { /* checked below */ } }
  for (const d of [p.runDir, p.vaultDir]) { try { fs.rmdirSync(d); } catch (err) { /* not empty or gone */ } }
  // Look again: what is still on disk counts, whatever each call said.
  for (const f of targets(opts).files) if (!left.includes(f.path)) left.push(f.path);
  for (const d of t.dirs) if (fs.existsSync(d) && !left.includes(d)) left.push(d);
  return { removed: removed.filter((f) => !left.includes(f)), left, key, backend: t.backend, probe: t.probe };
}

/** The sentence for a key that is not confirmed gone, or null. */
function keyProblem(r) {
  if (r.key === 'kept') return 'The vault key in your system keychain was kept, so what is left of the vault can still be opened.';
  if (r.key === 'left' || r.key === 'unconfirmed') {
    return 'The vault key could not be removed from your ' + r.backend + ' keychain' + (r.key === 'unconfirmed' ? ' (zn could not check)' : '') +
      '. It is harmless without the files; remove the "zn" entry by hand.';
  }
  return null;
}

/** A note (not a failure) when keychain.json is damaged and a native backend still holds a zn entry, or null. */
function keyNote(r) {
  if (!r.probe) return null;
  return 'zn could not read the vault settings (damaged), and your ' + r.probe + ' keychain still holds a "zn" entry. zn cannot tell whether it belongs to this vault, so it was not touched. It is harmless without the vault files; remove the "zn" entry by hand if you use no other vault.';
}

/**
 * Returns the exit code. opts: { yes }. io (tests): stdin, env, ancestry, ask(question), out(line).
 * Throws the "needs a person" refusals.
 */
async function purgeVault(opts, io) {
  const o = opts || {};
  const i = io || {};
  const out = i.out || ((s) => process.stdout.write(s + '\n'));
  if (o.yes) {
    // A script has no terminal, but an agent still may not purge.
    const agent = tty.agentDetected(i.env || process.env, i);
    if (agent) { const e = new Error(messages.agentRefusal('zn vault purge', agent)); e.code = 'ZN_POLICY_DENIED'; throw e; }
  } else {
    tty.requireHuman('zn vault purge', i);
  }
  const t = targets(o);
  if (!t.files.length) {
    out('There is no vault here to purge. Nothing was changed.');
    const note = keyNote(t);
    if (note) out(note);
    return 0;
  }
  const policyFiles = policy.paths(o);
  if ([policyFiles.teamFile, policyFiles.policyFile].some((x) => fs.existsSync(x))) { process.stderr.write('[zn] ' + reset.TEAM_REFUSAL + '\n'); return 1; }
  if (await daemon.isRunning(o)) { process.stderr.write('[zn] The vault is unlocked. Run `' + zn('lock') + '` first, then `' + zn('vault purge') + '`.\n'); return 1; }

  out('This deletes the vault for good, with every backup. It cannot be undone. These ' + t.files.length + ' files will be deleted:');
  for (const f of t.files) out('  - ' + f.path + '  (' + f.kind + ')');
  if (t.backend && t.backend !== 'passphrase') out('  - the vault key in your ' + t.backend + ' keychain');
  out('To keep an encrypted copy and start a new vault instead, use `' + zn('vault reset') + '`.');
  if (!o.yes) {
    const answer = await (i.ask || ((q) => reset.askLine(q, i)))('To go on, type "' + PHRASE + '" and press Enter: ');
    if (String(answer).trim().toLowerCase() !== PHRASE) { out('Nothing was purged: the phrase did not match. Your vault is as it was.'); return 1; }
  }

  const r = await removeAll(o);
  const problem = keyProblem(r);
  if (r.left.length || problem) {
    if (r.left.length) {
      out('The vault was NOT fully purged. These could not be removed:');
      for (const f of r.left) out('  - ' + f);
      out('Delete them by hand (or fix their permissions) and run `' + zn('vault purge') + '` again.');
    }
    if (problem) out(problem);
    return 1;
  }
  try { reset.clearUnlockFailures(o); } catch (err) { /* none */ }
  out('Purged: ' + r.removed.length + ' files deleted, and a new check found none left. Run `' + zn('unlock') + '` to create a new vault.');
  const note = keyNote(r);
  if (note) out(note);
  return 0;
}

module.exports = { purgeVault, targets, removeAll, keyProblem, keyNote, summary, PHRASE, _unlinkGone: unlinkGone };
