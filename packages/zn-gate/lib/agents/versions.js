'use strict';

/**
 * The agent version found on this machine, next to the version zn was last tested with (tested-versions.json).
 * Read only: it starts nothing but `<agent> --version`, with a 2 second timeout, in an empty folder, with a bare
 * environment (no tokens, no proxy settings) and updates and notices turned off. A program that is not found, fails,
 * times out or prints no version number gives no version, never an error.
 *
 * On Windows most agents are installed as a script shim (`codex.cmd`, `cursor.cmd`) that zn does not start: starting
 * a .cmd file needs a shell, and zn never runs one for a check. Such an agent is still reported as installed, with
 * its version unknown, instead of as missing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const TESTED = require('./tested-versions.json').agents;

const VERSION_RE = /\b(\d{1,6})\.(\d{1,6})\.(\d{1,6})\b/;
const WIN_EXTS = '.COM;.EXE;.BAT;.CMD';

function parts(v) {
  const m = VERSION_RE.exec(String(v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1 comparing two x.y.z versions; null when either is not one. */
function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

function testedVersion(id) {
  const e = Object.hasOwn(TESTED, id) ? TESTED[id] : null;
  return e && e.tested ? e.tested : null;
}

/* Where the agent's program is: {file, shim} or null. shim is true for a Windows script (.cmd, .bat) that is only
   located, never started. On Windows a PATH folder inside the working folder is skipped, as findProgram does. */
function locateProgram(id, opts = {}) {
  const e = Object.hasOwn(TESTED, id) ? TESTED[id] : null;
  if (!e || !e.command) return null;
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const exe = require('./../exe');
  const real = exe.findProgram(e.command, env, cwd);
  if (real) return { file: real, shim: false };
  if ((opts.platform || process.platform) !== 'win32') return null;
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = String(env.PATHEXT || WIN_EXTS).split(';').filter(Boolean);
  const inCwd = (d) => {
    const dir = path.resolve(d).toLowerCase();
    const here = path.resolve(cwd).toLowerCase();
    return dir === here || dir.startsWith(here + path.sep);
  };
  for (const d of dirs) {
    if (inCwd(d)) continue;
    for (const x of exts) {
      const file = path.join(d, e.command + x.toLowerCase());
      if (fs.existsSync(file)) return { file, shim: !/\.(exe|com)$/i.test(x) };
    }
  }
  return null;
}

/* The version `<agent> --version` prints for a located program, or null. Never runs a shim. */
function probeVersion(loc, opts = {}) {
  if (!loc || loc.shim) return null;
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const bare = { PATH: require('./../exe').programEnv(env, process.platform, cwd).PATH, HOME: env.HOME || os.homedir(), USERPROFILE: env.USERPROFILE || os.homedir(), NO_UPDATE_NOTIFIER: '1', DISABLE_AUTOUPDATER: '1', CI: '1' };
  if (process.platform === 'win32') {
    for (const k of ['SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA']) if (env[k]) bare[k] = env[k];
  }
  try {
    const r = spawnSync(loc.file, ['--version'], { env: bare, cwd: os.tmpdir(), timeout: opts.timeoutMs || 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 65536, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    const m = VERSION_RE.exec(String(r.stdout || '').slice(0, 4096));
    return m ? m[0] : null;
  } catch (_) {
    return null;
  }
}

/** The version `<agent> --version` prints, or null. opts: env, cwd, timeoutMs. */
function foundVersion(id, opts = {}) {
  return probeVersion(locateProgram(id, opts), opts);
}

/** {found, tested, installed, relation: 'same' | 'newer' | 'older' | 'unknown' | 'not-found'} for one agent.
 * installed: the agent's program is on this machine (opts.installed overrides the lookup; check passes what it already
 * knows). relation 'not-found' means no version was read, whether or not the agent is installed. */
function versionInfo(id, opts = {}) {
  const loc = locateProgram(id, opts);
  const found = probeVersion(loc, opts);
  const tested = testedVersion(id);
  const installed = typeof opts.installed === 'boolean' ? opts.installed : !!loc;
  if (!found) return { found: null, tested, installed, relation: 'not-found' };
  const c = tested ? compareVersions(found, tested) : null;
  return { found, tested, installed, relation: c === null ? 'unknown' : c > 0 ? 'newer' : c < 0 ? 'older' : 'same' };
}

/** The plain-language line for the report. */
function versionLine(info) {
  if (info.relation === 'not-found') return info.installed ? 'version: unknown (zn could not read it on this machine)' : 'version: not found';
  if (info.relation === 'same') return `version ${info.found}, the version zn was last tested with`;
  if (info.relation === 'newer') return `version ${info.found}, newer than ${info.tested}, the last version zn was tested with. It may still work. If a hook does not run, report it at https://github.com/usezn/zn/issues`;
  if (info.relation === 'older') return `version ${info.found}, older than ${info.tested}, the last version zn was tested with. If a hook does not run, update the agent first, then report it at https://github.com/usezn/zn/issues`;
  return `version ${info.found}, no tested version recorded`;
}

module.exports = { compareVersions, testedVersion, locateProgram, foundVersion, versionInfo, versionLine, TESTED };
