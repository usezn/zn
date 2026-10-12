#!/usr/bin/env node
'use strict';

/**
 * zn-gate plugin launcher.
 *
 * Every hook and MCP server of this plugin goes through this file:
 *
 *   node zn-launch.js hook <agent>     agent hook (event JSON on stdin)
 *   node zn-launch.js secrets-mcp      the "secrets" MCP server (stdio)
 *   node zn-launch.js check [agent]    report the installation status; never blocks
 *
 * It does not download, install or update anything. On every run it:
 *
 *  1. finds the zn-gate package the user installed (see findPackage);
 *  2. walks the whole package directory and requires it to hold exactly the
 *     files listed in zn-gate.lock.json: no extra file or directory, no
 *     symbolic link, nothing missing, every file with the SHA-256 digest of
 *     the published release;
 *  3. loads zn-gate's hook runner or MCP server from the bytes it just
 *     verified, held in memory, with a module loader that resolves only
 *     within the verified file set. Nothing zn-gate loads in this process is
 *     read from disk again after the check.
 *
 * Any failure, including an exception thrown by zn-gate itself, refuses the
 * hook event (exit code 2 and a message that says how to fix it) and keeps
 * the MCP server from starting. The user can let hook events pass instead
 * with {"hooks": {"whenUnavailable": "allow"}} in ~/.zn/config.json.
 *
 * What this does not protect against (see the plugin README):
 *  - Child processes zn-gate starts (the vault daemon, `zn run`, the stream
 *    scrubber) and the ES modules of its bundled dependencies are loaded from
 *    disk by Node after the check, so a change made in between is not seen.
 *  - Whoever controls the environment the agent starts hooks with decides
 *    which `node` runs this file, can preload code with NODE_OPTIONS before
 *    this file starts, and chooses the PATH used to find zn-gate (only an
 *    exact copy of the pinned release passes the check).
 *  - Code running as the user can edit this plugin or ~/.zn/config.json.
 * It reduces what a prompt-injected agent can do through its own tools; it
 * is not a sandbox.
 *
 * No dependencies; Node.js 20.12 or later.
 */

const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const url = require('url');
const vm = require('vm');

const LOCK_FILE = path.join(__dirname, 'zn-gate.lock.json');
// vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER: Node.js 20.12 / 21.7 and later.
const NODE_OK = !!(vm.constants && vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER);
const NODE_HINT = 'the zn-gate plugin needs Node.js 20.12 or later (this is ' + process.version + ').';
const SUPPORTED_AGENTS = new Set(['claude-code', 'codex', 'cursor']);

// zn-gate starts child processes with this process's environment; a preload
// set through NODE_OPTIONS or a module path in NODE_PATH must not reach them.
delete process.env.NODE_OPTIONS;
delete process.env.NODE_PATH;

/* The account's home directory from the user database, not from $HOME. */
function homeDir() {
  try {
    const h = os.userInfo().homedir;
    if (h) return h;
  } catch (_) { /* no passwd entry (some containers) */ }
  return os.homedir();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function znConfig() {
  return readJson(path.join(homeDir(), '.zn', 'config.json')) || {};
}

function loadLock() {
  const lock = readJson(LOCK_FILE);
  if (!lock || lock.package !== 'zn-gate' || typeof lock.version !== 'string' || !lock.files || typeof lock.files !== 'object') {
    throw new Error('the plugin lock file (scripts/zn-gate.lock.json) is missing or invalid');
  }
  return lock;
}

function installHint(lock) {
  return 'Install the pinned release with: npm install -g zn-gate@' + lock.version +
    ' && npm audit signatures (see the plugin README).';
}

/* ----------------------------- lookup ----------------------------- */

function isPackageDir(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  return !!(pkg && pkg.name === 'zn-gate');
}

/**
 * Candidate package directories, in order:
 *   1. "plugin": {"packageDir": "<dir>"} in ~/.zn/config.json (only that one);
 *   2. for each PATH entry with a zn-gate executable, the npm global layouts
 *      of Linux and macOS (<prefix>/bin -> <prefix>/lib/node_modules) and of
 *      Windows (<prefix>\zn-gate.cmd next to <prefix>\node_modules).
 */
function candidates() {
  const cfg = znConfig();
  if (cfg.plugin && typeof cfg.plugin.packageDir === 'string') return [path.resolve(cfg.plugin.packageDir)];
  const out = [];
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const bin = path.join(dir, 'zn-gate');
    try {
      out.push(path.resolve(path.dirname(fs.realpathSync(bin)), '..'));
    } catch (_) { /* not here */ }
    if (fs.existsSync(bin + '.cmd')) out.push(path.join(dir, 'node_modules', 'zn-gate'));
    if (fs.existsSync(bin)) out.push(path.resolve(dir, '..', 'lib', 'node_modules', 'zn-gate'));
  }
  return [...new Set(out)];
}

/* --------------------------- verification --------------------------- */

/**
 * Read the whole package tree and compare it with the lock file.
 * Returns {files: Map<rel, Buffer>} or {error}.
 */
function readVerified(dir, lock) {
  const expected = lock.files;
  const dirs = new Set(['']);
  for (const rel of Object.keys(expected)) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const files = new Map();
  const problems = [];
  const walk = (rel) => {
    const abs = rel ? path.join(dir, ...rel.split('/')) : dir;
    let names;
    try {
      names = fs.readdirSync(abs);
    } catch (err) {
      problems.push('cannot read ' + (rel || '.') + ' (' + err.code + ')');
      return;
    }
    for (const name of names) {
      const r = rel ? rel + '/' + name : name;
      const st = fs.lstatSync(path.join(abs, name));
      if (st.isSymbolicLink()) problems.push(r + ' is a symbolic link');
      else if (st.isDirectory()) {
        if (dirs.has(r)) walk(r);
        else problems.push('unexpected directory ' + r);
      } else if (st.isFile()) {
        if (!Object.prototype.hasOwnProperty.call(expected, r)) problems.push('unexpected file ' + r);
        else {
          const buf = fs.readFileSync(path.join(abs, name));
          if (crypto.createHash('sha256').update(buf).digest('hex') !== expected[r]) problems.push(r + ' was changed');
          else files.set(r, buf);
        }
      } else problems.push(r + ' is not a regular file');
      if (problems.length) return;
    }
  };
  walk('');
  if (!problems.length) {
    const missing = Object.keys(expected).find((r) => !files.has(r));
    if (missing) problems.push(missing + ' is missing');
  }
  if (problems.length) return { error: problems[0] };
  return { files };
}

/**
 * Find the package and verify it. Every candidate is tried; the first one
 * that matches the lock file wins. Returns {dir, files} or {error}.
 */
function verify(lock) {
  if (!NODE_OK) return { error: NODE_HINT };
  if (Object.keys(lock.files).length === 0) {
    return { error: 'this plugin build has no file digests for zn-gate ' + lock.version + ' (development build), so it cannot run. ' +
      'Use a released plugin version.' };
  }
  const reasons = [];
  for (const dir of candidates()) {
    if (!isPackageDir(dir)) continue;
    const real = fs.realpathSync(dir);
    const pkg = readJson(path.join(real, 'package.json')) || {};
    if (pkg.version !== lock.version) {
      reasons.push(real + ' holds zn-gate ' + (pkg.version || 'of an unknown version'));
      continue;
    }
    const res = readVerified(real, lock);
    if (res.files) return { dir: real, files: res.files };
    reasons.push(real + ' does not match the published zn-gate ' + lock.version + ': ' + res.error);
  }
  if (!reasons.length) return { error: 'zn-gate ' + lock.version + ' is not installed (no zn-gate executable on PATH). ' + installHint(lock) };
  return { error: 'this plugin needs zn-gate ' + lock.version + ', but ' + reasons.join('; ') + '. ' + installHint(lock) };
}

/* ------------------------- in-memory loader ------------------------- */

const isBuiltin = Module.isBuiltin || ((id) => Module.builtinModules.includes(String(id).replace(/^node:/, '')));

/**
 * A CommonJS loader over the verified file set. require() of a relative path
 * or a package resolves only to verified files; built-in modules come from
 * Node. import() is handed to Node's own loader: ES modules cannot be
 * evaluated from memory without experimental flags. Since the tree holds no
 * file outside the lock, it resolves to a verified file (zn-gate imports only
 * its bundled age-encryption), but Node reads it from disk again.
 */
function makeLoader(dir, files) {
  const cache = new Map();
  const has = (rel) => files.has(rel);
  const norm = (rel) => path.posix.normalize(rel).replace(/^\.\//, '');

  function packageEntry(pkgRel, sub) {
    const pj = files.get(pkgRel + '/package.json');
    const meta = pj ? JSON.parse(pj.toString('utf8')) : {};
    if (sub) return asFile(pkgRel + '/' + sub);
    const exp = typeof meta.exports === 'string' ? meta.exports
      : meta.exports && typeof meta.exports['.'] === 'string' ? meta.exports['.']
        : meta.exports && meta.exports['.'] && (meta.exports['.'].require || meta.exports['.'].default || meta.exports['.'].import);
    const main = typeof exp === 'string' ? exp : meta.main || 'index.js';
    return asFile(norm(pkgRel + '/' + main)) || asFile(pkgRel + '/index');
  }

  function asFile(rel) {
    rel = norm(rel);
    for (const c of [rel, rel + '.js', rel + '.json', rel + '.cjs', rel + '.mjs']) if (has(c)) return c;
    if (files.has(rel + '/package.json')) return packageEntry(rel, '');
    for (const c of [rel + '/index.js', rel + '/index.json']) if (has(c)) return c;
    return null;
  }

  function resolve(spec, fromRel) {
    const base = path.posix.dirname(fromRel);
    if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
      const rel = norm(path.posix.join(base, spec));
      if (rel.startsWith('..')) return null;
      return asFile(rel);
    }
    if (path.isAbsolute(spec)) {
      const rel = path.relative(dir, spec).split(path.sep).join('/');
      return rel.startsWith('..') || path.isAbsolute(rel) ? null : asFile(rel);
    }
    const m = /^((?:@[^/]+\/)?[^/]+)(?:\/(.*))?$/.exec(spec);
    if (!m) return null;
    let d = base;
    for (;;) {
      const pkgRel = norm((d === '.' ? '' : d + '/') + 'node_modules/' + m[1]);
      if (files.has(pkgRel + '/package.json') || [...files.keys()].some((k) => k.startsWith(pkgRel + '/'))) {
        return packageEntry(pkgRel, m[2] || '');
      }
      if (d === '.' || d === '') break;
      d = path.posix.dirname(d);
    }
    return null;
  }

  function notFound(spec, fromRel) {
    const err = new Error("Cannot find module '" + spec + "' among the verified zn-gate files (required from " + fromRel + ')');
    err.code = 'MODULE_NOT_FOUND';
    return err;
  }

  function load(rel) {
    if (cache.has(rel)) return cache.get(rel).exports;
    const filename = path.join(dir, ...rel.split('/'));
    const mod = { id: filename, filename, loaded: false, exports: {}, children: [], paths: [] };
    cache.set(rel, mod);
    const src = files.get(rel).toString('utf8').replace(/^﻿/, '');
    if (rel.endsWith('.json')) {
      mod.exports = JSON.parse(src);
      mod.loaded = true;
      return mod.exports;
    }
    const req = (spec) => {
      spec = String(spec);
      if (isBuiltin(spec)) return require(spec);
      const target = resolve(spec, rel);
      if (!target) throw notFound(spec, rel);
      return load(target);
    };
    req.resolve = (spec) => {
      if (isBuiltin(spec)) return spec;
      const target = resolve(String(spec), rel);
      if (!target) throw notFound(spec, rel);
      return path.join(dir, ...target.split('/'));
    };
    req.cache = Object.create(null);
    req.main = undefined;
    const code = src.startsWith('#!') ? '//' + src.slice(2) : src;
    const fn = vm.compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname'], {
      filename,
      // import() goes to Node's own ES module loader, resolved from this
      // file's location inside the verified tree (see the header).
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    fn.call(mod.exports, mod.exports, req, mod, filename, path.dirname(filename));
    mod.loaded = true;
    return mod.exports;
  }

  return { load, resolve };
}

/* ------------------------------ modes ------------------------------ */

function whenUnavailableAllows() {
  const hooks = znConfig().hooks || {};
  return String(hooks.whenUnavailable || '').toLowerCase() === 'allow';
}

let refused = false;
function refuseHook(agent, why) {
  if (refused) return;
  refused = true;
  if (whenUnavailableAllows()) {
    process.stderr.write('zn plugin: ' + why + ' Event passed through (hooks.whenUnavailable is "allow").\n');
    process.exitCode = 0;
    return;
  }
  const msg = 'zn plugin: ' + why + ' Until then zn cannot check this call, so it is refused. ' +
    'To let events pass while zn-gate is unavailable, set {"hooks": {"whenUnavailable": "allow"}} in ~/.zn/config.json.';
  process.stderr.write(msg + '\n');
  if (agent === 'cursor') {
    process.stdout.write(JSON.stringify({ permission: 'deny', continue: false, user_message: msg, agent_message: msg }));
  }
  process.exitCode = 2;
}

function failClosedOnCrash(agent) {
  const onError = (err) => {
    refuseHook(agent, 'zn-gate failed (' + ((err && err.message) || String(err)) + ').');
    // Exit now: whatever was running is in an unknown state.
    process.exit(process.exitCode);
  };
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);
}

function runHook(agent) {
  if (!SUPPORTED_AGENTS.has(agent)) {
    process.stderr.write('zn plugin: unknown agent "' + agent + '"\n');
    process.exitCode = 1;
    return;
  }
  failClosedOnCrash(agent);
  try {
    const lock = loadLock();
    const res = verify(lock);
    if (res.error) return refuseHook(agent, res.error);
    const loader = makeLoader(res.dir, res.files);
    const runner = loader.load('lib/hooks/runner.js');
    // The runner reads the event from stdin and writes the agent's answer.
    Promise.resolve(runner.main([agent])).catch((err) => {
      refuseHook(agent, 'zn-gate failed (' + ((err && err.message) || String(err)) + ').');
    });
  } catch (err) {
    refuseHook(agent, 'zn-gate failed to load (' + ((err && err.message) || String(err)) + ').');
  }
}

function runMcp() {
  const fail = (msg) => {
    process.stderr.write('zn plugin: ' + msg + '\n');
    process.exit(1);
  };
  process.on('uncaughtException', (err) => fail('zn-gate failed (' + ((err && err.message) || String(err)) + ')'));
  process.on('unhandledRejection', (err) => fail('zn-gate failed (' + ((err && err.message) || String(err)) + ')'));
  const lock = loadLock();
  const res = verify(lock);
  if (res.error) return fail(res.error);
  makeLoader(res.dir, res.files).load('lib/broker/mcp.js').startSecretsMcp();
}

/* Hooks that `zn hooks install` wrote into the agent's own settings run too. */
function settingsHooks(agent) {
  if (agent !== 'claude-code') return false;
  const re = /(\bhook claude-code|hooks[\\/]runner\.js"? claude-code)\s*$/;
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), '.claude');
  const data = readJson(path.join(dir, 'settings.json'));
  const events = data && data.hooks && typeof data.hooks === 'object' ? Object.values(data.hooks) : [];
  for (const groups of events) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of (g && Array.isArray(g.hooks)) ? g.hooks : []) {
        if (h && typeof h.command === 'string' && re.test(h.command)) return true;
      }
    }
  }
  return false;
}

function runCheck(agent) {
  let message;
  try {
    const res = verify(loadLock());
    if (res.error) message = 'zn plugin: ' + res.error;
    else if (settingsHooks(agent)) {
      message = 'zn plugin: zn hooks are also installed in your Claude Code settings, so every event is checked twice. ' +
        'Remove them with: zn hooks uninstall claude-code';
    }
  } catch (err) {
    message = 'zn plugin: ' + err.message + '.';
  }
  if (!message) return;
  if (agent === 'claude-code') process.stdout.write(JSON.stringify({ systemMessage: message }));
  else process.stderr.write(message + '\n');
}

function main(argv) {
  const [mode, agent] = argv;
  if (mode === 'hook') return runHook(agent);
  if (mode === 'secrets-mcp') return runMcp();
  if (mode === 'check') return runCheck(agent || '');
  process.stderr.write('usage: zn-launch.js hook <claude-code|codex|cursor> | secrets-mcp | check [agent]\n');
  process.exitCode = 1;
}

module.exports = { verify, loadLock, makeLoader, readVerified };

if (require.main === module) main(process.argv.slice(2));
