'use strict';

/**
 * Where does a path live relative to git? Used by the restore policy
 * (write to an ignored file: restore; to a tracked file: keep the token) and
 * by secrets_render_file (values only in ignored paths or outside a repo).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function existingDir(p) {
  let cur = path.resolve(p);
  for (;;) {
    try {
      if (fs.statSync(cur).isDirectory()) return cur;
    } catch (_) { /* walk up */ }
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

/**
 * 'ignored' | 'tracked' | 'outside' | 'unknown'
 *   ignored: inside a git work tree and matched by .gitignore
 *   tracked: inside a git work tree and not ignored (could be committed)
 *   outside: not inside any git work tree
 *   unknown: git is not available; callers treat it as 'tracked'
 */
function gitStatusOf(file) {
  const abs = path.resolve(file);
  const dir = existingDir(path.dirname(abs));
  const top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  if (top.error) return 'unknown';
  if (top.status !== 0) return 'outside';
  const ign = spawnSync('git', ['-C', dir, 'check-ignore', '-q', '--', abs], { encoding: 'utf8', windowsHide: true });
  if (ign.error) return 'unknown';
  if (ign.status === 0) return 'ignored';
  if (ign.status === 1) return 'tracked';
  return 'unknown';
}

/**
 * fs.realpathSync, but on Windows the native call: the JavaScript one leaves 8.3
 * short names (RUNNER~1) unexpanded, so a check against long names would miss them.
 */
function realpath(p) {
  if (process.platform === 'win32' && typeof fs.realpathSync.native === 'function') {
    try { return fs.realpathSync.native(p); } catch (_) { /* fall back below */ }
  }
  return fs.realpathSync(p);
}

/**
 * The path a file has, or would have once created: the nearest existing
 * ancestor with its symlinks resolved, then the rest of the path as typed.
 */
function realTargetOf(file) {
  const abs = path.resolve(file);
  const root = path.parse(abs).root;
  const parts = abs.slice(root.length).split(path.sep).filter(Boolean);
  // Walk down to the first name that does not exist (nothing below it can),
  // then resolve that ancestor once: a long path that does not exist costs one
  // check per existing level, not one realpath per missing one.
  let cur = root;
  let i = 0;
  while (i < parts.length) {
    const next = path.join(cur, parts[i]);
    if (!fs.existsSync(next)) break;
    cur = next;
    i++;
  }
  try {
    return path.join(realpath(cur), ...parts.slice(i));
  } catch (_) {
    return abs;
  }
}

/** Write a file atomically with mode 0600 (best effort on Windows). */
function writeFileAtomic(file, data, mode = 0o600) {
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.zn-tmp');
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

module.exports = { gitStatusOf, realpath, realTargetOf, writeFileAtomic };
