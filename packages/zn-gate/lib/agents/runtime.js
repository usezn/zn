'use strict';

/**
 * A runner that survives its package manager's cache.
 *
 * `npx -y zn-gate hooks install <agent>` runs zn-gate from a temporary copy
 * (npm's _npx cache, pnpm/yarn dlx, bunx). That folder can be removed at any
 * time (`npm cache clean`, a cleanup tool, a new npm version), and a hook that
 * names a runner inside it would then stop working. So when the runner is in
 * such a folder, the install copies the zn-gate package into a folder zn
 * owns, ~/.zn/runtime/<version>/zn-gate (or $ZN_HOME/runtime/...), and the
 * hooks name that copy. The copy is a plain zn-gate package (bin, lib,
 * package.json and the bundled node_modules), so it runs as it did from the
 * cache. A copy is complete only once its marker file is there; an
 * incomplete one is replaced.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEMP_COPY = /[\/](?:_npx|dlx(?:-[^\/]*)?|xfs-[^\/]*|\.bun[\/]install[\/]cache|bunx-[^\/]*)[\/]/;
const MARKER = '.zn-runtime-complete';
const RUNNER_REL = path.join('lib', 'hooks', 'runner.js');

/** Whether a path is inside a temporary copy of a package (npx cache, dlx, bunx). */
function inTemporaryCopy(p) {
  return TEMP_COPY.test(String(p).replace(/\\/g, '/'));
}

function runtimeDir(opts = {}) {
  const env = opts.env || process.env;
  const base = env.ZN_HOME ? path.resolve(env.ZN_HOME) : path.join(opts.home || os.homedir(), '.zn');
  return path.join(base, 'runtime');
}

/**
 * The runner a hook should name: `runner` itself, or, when it sits in a
 * temporary copy, the same file in zn's own copy of the package (made here).
 * Throws when the copy cannot be made, so an install never leaves a hook
 * that depends on a cache folder.
 */
function stableRunner(runner, opts = {}) {
  if (!inTemporaryCopy(runner)) return runner;
  const pkgRoot = path.resolve(path.dirname(runner), '..', '..');
  if (path.join(pkgRoot, RUNNER_REL) !== path.resolve(runner)) return runner;
  let version;
  try { version = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version; } catch (err) { version = null; }
  if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]+$/.test(version)) {
    throw new Error('zn: cannot keep a copy of zn-gate from the npx cache (no readable version in ' + pkgRoot + '); run `npm install -g zn-gate` and then `zn hooks install` again');
  }
  const base = path.join(runtimeDir(opts), version);
  const dest = path.join(base, 'zn-gate');
  const target = path.join(dest, RUNNER_REL);
  if (fs.existsSync(path.join(dest, MARKER)) && fs.existsSync(target)) return target;
  const tmp = base + '.tmp-' + process.pid;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    const copy = path.join(tmp, 'zn-gate');
    fs.mkdirSync(copy, { recursive: true, mode: 0o700 });
    for (const name of ['bin', 'lib', 'node_modules', 'package.json']) {
      const from = path.join(pkgRoot, name);
      if (!fs.existsSync(from)) continue;
      fs.cpSync(from, path.join(copy, name), { recursive: true, dereference: true, filter: (src) => path.basename(src) !== '.bin' });
    }
    if (!fs.statSync(path.join(copy, RUNNER_REL)).isFile()) throw new Error('runner missing in the copy');
    fs.writeFileSync(path.join(copy, MARKER), version + '\n');
    fs.rmSync(base, { recursive: true, force: true });
    fs.renameSync(tmp, base);
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    throw new Error('zn: could not keep a copy of zn-gate for its hooks (' + err.message + '); run `npm install -g zn-gate` and then `zn hooks install` again');
  }
  return target;
}

module.exports = { inTemporaryCopy, stableRunner, runtimeDir };
