'use strict';
/*
 * zn's state folder (~/.zn, or the folder ZN_HOME names) and its private subfolders hold the vault, the audit log,
 * the stats and the hook's memory. One rule for all of them on POSIX systems:
 *   - a folder that is owned by this account is tightened to owner-only, 0700 (group and other access, setgid and sticky are
 *     removed), also when it existed before with a looser mode;
 *   - a folder owned by someone else, or one that cannot be tightened, is not used: ensureStateDir throws, and the
 *     hook turns that into a block.
 * Windows has no such modes here: nothing is done (the vault sets its own ACL).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CODE = 'ZN_STATE_DIR';

function shown(dir) {
  const home = os.homedir();
  const d = path.resolve(dir);
  return home && (d === home || d.startsWith(home + path.sep)) ? '~' + d.slice(home.length) : d;
}

function stateError(dir, why) {
  const err = new Error('the zn state folder ' + shown(dir) + ' ' + why + ', so zn will not use it. ' +
    'Next step: run `chmod 700 ' + shown(dir) + '` as its owner, or choose another folder with ZN_HOME.');
  err.code = CODE;
  return err;
}

function posix() {
  return process.platform !== 'win32' && typeof process.getuid === 'function';
}

/* The state folders above `dir` that are tightened with it: the state folder itself, when `dir` lies inside it. */
function chainOf(dir) {
  const out = [path.resolve(dir)];
  try {
    const roots = [require('./stats').znHome(), require('./stats').userHome()].filter(Boolean).map((r) => path.resolve(r));
    for (const root of roots) {
      if (out[0] !== root && out[0].startsWith(root + path.sep)) { out.push(root); break; }
    }
  } catch (_) { /* the leaf alone */ }
  return out;
}

function tighten(dir) {
  let st;
  try { st = fs.statSync(dir); } catch (err) { throw stateError(dir, 'cannot be read (' + (err.code || 'error') + ')'); }
  if (!st.isDirectory()) throw stateError(dir, 'is not a folder');
  if (st.uid !== process.getuid()) throw stateError(dir, 'is owned by another user');
  if ((st.mode & 0o7077) === 0) return; // owner-only already (a stricter folder, such as 0500, stays as it is)
  const want = st.mode & 0o700;
  try { fs.chmodSync(dir, want); } catch (err) { throw stateError(dir, 'is open to other accounts and cannot be restricted (' + (err.code || 'error') + ')'); }
  const after = fs.statSync(dir);
  if ((after.mode & 0o7077) !== 0) throw stateError(dir, 'is open to other accounts and cannot be restricted');
}

/**
 * Makes `dir` (and its parents) when missing and tightens it, as above. opts.create === false only checks a folder
 * that exists. Throws an error with code ZN_STATE_DIR when the folder must not be used.
 */
function ensureStateDir(dir, opts = {}) {
  if (!posix()) {
    if (opts.create !== false) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  if (opts.create === false && !fs.existsSync(dir)) return;
  if (opts.create !== false) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  for (const d of chainOf(dir)) tighten(d);
}

/* What `check` says about the folder: [] when it is private or absent, one sentence otherwise. Never throws. */
function describe(dir) {
  try {
    if (!posix() || !fs.existsSync(dir)) return [];
    const st = fs.statSync(dir);
    const mode = (st.mode & 0o7777).toString(8).padStart(4, '0');
    if (st.uid !== process.getuid()) return ['The zn state folder ' + shown(dir) + ' is owned by another user (mode ' + mode + '), so zn will not use it. Use another folder with ZN_HOME.'];
    if ((st.mode & 0o7077) !== 0) return ['The zn state folder ' + shown(dir) + ' has mode ' + mode + ', which other accounts can use. zn restricts it to 0700 the next time it writes there.'];
  } catch (_) { /* a warning never fails the check */ }
  return [];
}

module.exports = { ensureStateDir, describe, CODE };
