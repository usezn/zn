'use strict';

/**
 * The agent version found on this machine, next to the version zn-gate was last tested with (tested-versions.json).
 * Read only: it starts nothing but `<agent> --version`, with a 2 second timeout, in an empty folder, with a bare
 * environment (no tokens, no proxy settings) and updates and notices turned off. A program that is not found, fails,
 * times out or prints no version number gives "not found", never an error.
 */

const os = require('os');
const { spawnSync } = require('child_process');
const TESTED = require('./tested-versions.json').agents;

const VERSION_RE = /\b(\d{1,6})\.(\d{1,6})\.(\d{1,6})\b/;

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

/** The version `<agent> --version` prints, or null. opts: env, cwd, timeoutMs. */
function foundVersion(id, opts = {}) {
  const e = Object.hasOwn(TESTED, id) ? TESTED[id] : null;
  if (!e || !e.command) return null;
  const env = opts.env || process.env;
  const file = require('./../exe').findProgram(e.command, env, opts.cwd || process.cwd());
  if (!file) return null;
  const bare = { PATH: require('./../exe').programEnv(env, process.platform, opts.cwd || process.cwd()).PATH, HOME: env.HOME || os.homedir(), USERPROFILE: env.USERPROFILE || os.homedir(), NO_UPDATE_NOTIFIER: '1', DISABLE_AUTOUPDATER: '1', CI: '1' };
  if (process.platform === 'win32') {
    for (const k of ['SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA']) if (env[k]) bare[k] = env[k];
  }
  try {
    const r = spawnSync(file, ['--version'], { env: bare, cwd: os.tmpdir(), timeout: opts.timeoutMs || 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 65536, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    const m = VERSION_RE.exec(String(r.stdout || '').slice(0, 4096));
    return m ? m[0] : null;
  } catch (_) {
    return null;
  }
}

/** {found, tested, relation: 'same' | 'newer' | 'older' | 'unknown' | 'not-found'} for one agent. */
function versionInfo(id, opts = {}) {
  const found = foundVersion(id, opts);
  const tested = testedVersion(id);
  if (!found) {
    // Why nothing was read: no version command for this agent, or its program is not on PATH (else it is on PATH but printed nothing usable).
    const command = Boolean(Object.hasOwn(TESTED, id) && TESTED[id] && TESTED[id].command);
    const onPath = command && Boolean(require('./../exe').findProgram(TESTED[id].command, opts.env || process.env, opts.cwd || process.cwd()));
    return { found: null, tested, relation: 'not-found', command, onPath };
  }
  const c = tested ? compareVersions(found, tested) : null;
  return { found, tested, relation: c === null ? 'unknown' : c > 0 ? 'newer' : c < 0 ? 'older' : 'same' };
}

/**
 * The plain-language line for the report. With the agent's name, a missing program is named as such; hooksInstalled
 * adds that the hooks still run when the agent runs (they need no program on PATH to be installed).
 */
function versionLine(info, name, hooksInstalled = false) {
  const tested = info.tested ? ` (tested with ${info.tested})` : '';
  if (info.relation === 'not-found' && name) {
    if (info.command === false) return `no version read: ${name} has no command that prints its version`;
    const hooks = hooksInstalled ? ' (hooks are installed; they run when the agent runs)' : '';
    if (info.onPath === false) return `${name} program not found on PATH` + hooks;
    return `${name} program on PATH printed no version` + hooks;
  }
  if (info.relation === 'not-found') return `version: not found${tested}`;
  if (info.relation === 'same') return `version ${info.found}, the version zn was last tested with`;
  if (info.relation === 'newer') return `version ${info.found}, newer than ${info.tested}, the last version zn was tested with. It may still work. If a hook does not run, report it at https://github.com/usezn/zn/issues`;
  if (info.relation === 'older') return `version ${info.found}, older than ${info.tested}, the last version zn was tested with. If a hook does not run, update the agent first, then report it at https://github.com/usezn/zn/issues`;
  return `version ${info.found}, no tested version recorded`;
}

module.exports = { compareVersions, testedVersion, foundVersion, versionInfo, versionLine, TESTED };
