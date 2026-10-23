'use strict';

/**
 * Runs from the package's `postinstall`: after `npm update -g zn-gate` the runner file is new, so the SHA-256
 * recorded in each hook launcher (lib/agents/launcher.js) no longer matches and the hooks would block until
 * the user runs `zn hooks install <agent>`. This rewrites the launchers zn-gate itself wrote, with this
 * package's runner and digest. It must never fail an install: every error is swallowed.
 *
 * Which launchers are touched:
 *  - only regular files named zn-hook-<agent>.sh in zn's launcher directory (same ZN_HOME / home rules as the
 *    installer) whose second line is the header zn writes for that same agent id;
 *  - only when the launcher points at THIS package's runner (an update in place), or when it points at a
 *    runner that no longer exists and this is a global install. A project-local `npm install zn-gate` has
 *    neither: the launcher keeps pointing at the global copy, so a project's node_modules is never wired into
 *    the user's hooks.
 * Windows has no launcher file to refresh (the script is inline in the agent's config): nothing happens there.
 * With `npm install --ignore-scripts` this does not run; `zn hooks install <agent>` is then the fix.
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 64 * 1024;

function realOrSame(p) {
  try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); }
}

function isExecutableFile(p) {
  try { return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true); } catch (_) { return false; }
}

/** Refreshes the launchers; returns the agent ids whose launcher changed. */
function refreshLaunchers(opts = {}) {
  const env = opts.env || process.env;
  if ((opts.platform || process.platform) === 'win32') return [];
  const launcher = require('./launcher');
  const runner = opts.runnerPath || path.resolve(__dirname, '..', 'hooks', 'runner.js');
  const node = opts.nodePath || process.execPath;
  const isGlobal = opts.global !== undefined ? opts.global : (env.npm_config_global === 'true' || env.npm_config_location === 'global');
  if (!fs.existsSync(runner)) return [];
  const dir = launcher.launcherDir({ env, home: opts.home });
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const done = [];
  for (const name of names.sort()) {
    try {
      const m = /^zn-hook-([a-z-]+)\.sh$/.exec(name);
      if (!m) continue;
      const id = m[1];
      const file = path.join(dir, name);
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      if (lines[0] !== '#!/bin/sh' || lines[1] !== '# Written by `zn hooks install ' + id + '`; replaced on every install. Do not edit.') continue;
      const r = /^ZN_RUNNER='([^'\n]+)'$/m.exec(text);
      const n = /^ZN_NODE='([^'\n]+)'$/m.exec(text);
      if (!r || !n) continue;
      const same = realOrSame(r[1]) === realOrSame(runner);
      const gone = !fs.existsSync(r[1]);
      if (!same && !(gone && isGlobal)) continue;
      const useNode = isExecutableFile(n[1]) ? n[1] : node;
      const next = launcher.unixScript(id, useNode, runner);
      if (next === text) continue;
      launcher.writeLauncher(id, useNode, runner, { env, home: opts.home });
      done.push(id);
    } catch (_) { /* one bad file never stops the others or the install */ }
  }
  return done;
}

/** The postinstall entry: quiet, and never throws. */
function main(opts = {}) {
  try {
    const done = refreshLaunchers(opts);
    if (done.length) (opts.out || ((s) => process.stdout.write(s)))('zn-gate: refreshed hook launchers for ' + done.join(', ') + '\n');
  } catch (_) { /* never fail the install */ }
}

module.exports = { refreshLaunchers, main };

if (require.main === module) {
  try { main(); } catch (_) { /* never fail the install */ }
  process.exitCode = 0;
}
