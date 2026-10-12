#!/usr/bin/env node
'use strict';

/**
 * zn-gate plugin launcher.
 *
 * Every hook and MCP server of this plugin goes through this file. It does
 * not download, install or update anything. It finds the zn-gate npm package
 * that the user installed, checks that it is exactly the version this plugin
 * release pins, checks every file of it against the SHA-256 digests in
 * zn-gate.lock.json, and only then loads it in this same process. The full
 * digest check runs at session start (check) and whenever the size, mtime,
 * ctime or inode of any package file changed since the last full check:
 *
 *   node zn-launch.js hook <agent>     agent hook (event JSON on stdin)
 *   node zn-launch.js secrets-mcp      the "secrets" MCP server (stdio)
 *   node zn-launch.js check [agent]    report the installation status; never blocks
 *
 * When the package is missing, has another version or does not match the
 * lock file, hooks fail closed (exit code 2: the call or the prompt is
 * refused, with a message that says how to fix it) and the MCP server does
 * not start. The user can let hook events pass instead with
 * {"hooks": {"whenUnavailable": "allow"}} in ~/.zn/config.json, the same
 * switch zn-gate itself uses. Agents cannot write that file: zn-gate's hooks
 * deny access to ~/.zn.
 *
 * Package lookup, in order:
 *   1. "plugin": {"packageDir": "<dir>"} in ~/.zn/config.json
 *   2. a zn-gate executable on PATH (npm global install layouts on
 *      Linux, macOS and Windows)
 * No environment variable can point this launcher at other code.
 *
 * No dependencies; Node.js 18 or later.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_FILE = path.join(__dirname, 'zn-gate.lock.json');
const SUPPORTED_AGENTS = new Set(['claude-code', 'codex', 'cursor']);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function znConfig() {
  return readJson(path.join(os.homedir(), '.zn', 'config.json')) || {};
}

function loadLock() {
  const lock = readJson(LOCK_FILE);
  if (!lock || lock.package !== 'zn-gate' || typeof lock.version !== 'string') {
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

function candidatesFromPath() {
  const out = [];
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const bin = path.join(dir, 'zn-gate');
    // Linux and macOS: <prefix>/bin/zn-gate is a symlink to
    // <prefix>/lib/node_modules/zn-gate/bin/cli.js.
    try {
      const real = fs.realpathSync(bin);
      out.push(path.resolve(path.dirname(real), '..'));
    } catch (_) { /* not here */ }
    // Windows: <prefix>\zn-gate.cmd next to <prefix>\node_modules\zn-gate.
    if (fs.existsSync(bin + '.cmd')) out.push(path.join(dir, 'node_modules', 'zn-gate'));
    out.push(path.resolve(dir, '..', 'lib', 'node_modules', 'zn-gate'));
  }
  return out;
}

function findPackage() {
  const cfg = znConfig();
  const configured = cfg.plugin && typeof cfg.plugin.packageDir === 'string' ? cfg.plugin.packageDir : null;
  const list = configured ? [path.resolve(configured)] : candidatesFromPath();
  for (const dir of list) {
    if (isPackageDir(dir)) return fs.realpathSync(dir);
  }
  return null;
}

/* --------------------------- verification --------------------------- */

const STAMP_FILE = path.join(os.homedir(), '.zn', 'plugin-verified.json');

function statKey(dir, names, lock) {
  const h = crypto.createHash('sha256').update(JSON.stringify({ lock, dir }));
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, ...name.split('/')));
      h.update([name, st.size, st.mtimeMs, st.ino, st.ctimeMs].join(':') + ';');
    } catch (_) {
      return null;
    }
  }
  return h.digest('hex');
}

function writeStamp(key) {
  try {
    fs.mkdirSync(path.dirname(STAMP_FILE), { recursive: true, mode: 0o700 });
    const tmp = STAMP_FILE + '.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ key, checked: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(tmp, STAMP_FILE);
  } catch (_) { /* the next call checks in full again */ }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Returns {dir} when the installed package is the pinned, unmodified release,
 * or {error} with a message for the user.
 */
function verify(lock, full) {
  const dir = findPackage();
  if (!dir) return { error: 'zn-gate is not installed (no zn-gate executable on PATH). ' + installHint(lock) };
  const pkg = readJson(path.join(dir, 'package.json')) || {};
  if (pkg.version !== lock.version) {
    return { error: 'this plugin needs zn-gate ' + lock.version + ' but ' + dir + ' holds ' + (pkg.version || 'an unknown version') + '. ' + installHint(lock) };
  }
  const files = lock.files || {};
  const names = Object.keys(files);
  if (names.length === 0) {
    const cfg = znConfig();
    if (cfg.plugin && cfg.plugin.allowUnverified === true) return { dir, unverified: true };
    return { error: 'this plugin build has no file digests for zn-gate ' + lock.version + ' (development build). ' +
      'Set {"plugin": {"allowUnverified": true}} in ~/.zn/config.json to use it anyway.' };
  }
  // A full check hashes every file (several MB). Hook calls reuse the result
  // of the last full check while no file's size, mtime or inode changed; the
  // record lives in ~/.zn, which zn's hooks keep agents out of.
  const key = statKey(dir, names, lock);
  if (!full && key && readJson(STAMP_FILE) && readJson(STAMP_FILE).key === key) return { dir };
  for (const name of names) {
    const file = path.join(dir, ...name.split('/'));
    let digest;
    try {
      digest = sha256(file);
    } catch (_) {
      return { error: 'zn-gate ' + lock.version + ' in ' + dir + ' is incomplete (' + name + ' is missing). ' + installHint(lock) };
    }
    if (digest !== files[name]) {
      return { error: 'zn-gate ' + lock.version + ' in ' + dir + ' does not match the published release (' + name + ' was changed). ' + installHint(lock) };
    }
  }
  if (key) writeStamp(key);
  return { dir };
}

/* ------------------------------ modes ------------------------------ */

function whenUnavailableAllows() {
  const hooks = znConfig().hooks || {};
  return String(hooks.whenUnavailable || '').toLowerCase() === 'allow';
}

function refuseHook(agent, why) {
  if (whenUnavailableAllows()) {
    process.stderr.write('zn plugin: ' + why + ' Event passed through (hooks.whenUnavailable is "allow").\n');
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

function runHook(agent) {
  if (!SUPPORTED_AGENTS.has(agent)) {
    process.stderr.write('zn plugin: unknown agent "' + agent + '"\n');
    process.exitCode = 1;
    return;
  }
  let lock;
  let res;
  try {
    lock = loadLock();
    res = verify(lock);
  } catch (err) {
    res = { error: err.message + '.' };
  }
  if (res.error) return refuseHook(agent, res.error);
  // The runner reads the event from stdin and writes the agent's answer.
  require(path.join(res.dir, 'lib', 'hooks', 'runner.js')).main([agent]);
}

function runMcp() {
  const lock = loadLock();
  const res = verify(lock);
  if (res.error) {
    process.stderr.write('zn plugin: ' + res.error + '\n');
    process.exitCode = 1;
    return;
  }
  require(path.join(res.dir, 'lib', 'broker', 'mcp.js')).startSecretsMcp();
}

/* Hooks that zn hooks install wrote into the agent's own settings run too. */
function settingsHooks(agent) {
  const re = /(\bhook claude-code|hooks[\\/]runner\.js"? claude-code)\s*$/;
  if (agent !== 'claude-code') return false;
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
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
    const lock = loadLock();
    const res = verify(lock, true);
    if (res.error) message = 'zn plugin: ' + res.error;
    else if (res.unverified) message = 'zn plugin: using zn-gate ' + lock.version + ' without file verification (development build).';
    if (!res.error && settingsHooks(agent)) {
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

module.exports = { verify, findPackage, loadLock };

if (require.main === module) main(process.argv.slice(2));
