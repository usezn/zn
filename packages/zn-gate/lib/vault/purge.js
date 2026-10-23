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
    for (const f of walk(d, [], dirs)) files.push({ path: f, kind: 'backup (' + n + ')' });
    dirs.push(d);
  }
  for (const f of walk(p.runDir, [])) files.push({ path: f, kind: path.basename(f) === 'session.key' ? 'session key' : 'daemon runtime file' });
  const fails = path.join(p.home, 'unlock-failures');
  try { if (fs.lstatSync(fails).isFile()) files.push({ path: fails, kind: 'failed-unlock counter' }); } catch (err) { /* none */ }
  let backend = null;
  try { const m = keychain.readMeta(opts); backend = m && m.backend; } catch (err) { /* damaged */ }
  return { files, dirs: dirs.sort((a, b) => b.length - a.length), backend };
}

/** Delete one file or link; returns true when it is gone. */
function unlinkGone(f) {
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
  for (const f of t.files) (unlinkGone(f.path) ? removed : left).push(f.path);
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
  return { removed: removed.filter((f) => !left.includes(f)), left, key, backend: t.backend };
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
  if (!t.files.length) { out('There is no vault here to purge. Nothing was changed.'); return 0; }
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
  return 0;
}

module.exports = { purgeVault, targets, removeAll, keyProblem, PHRASE };
