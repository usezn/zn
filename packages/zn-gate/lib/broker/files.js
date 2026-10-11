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

/** Write a file atomically with mode 0600 (best effort on Windows). */
function writeFileAtomic(file, data, mode = 0o600) {
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.zn-tmp');
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

module.exports = { gitStatusOf, writeFileAtomic };
