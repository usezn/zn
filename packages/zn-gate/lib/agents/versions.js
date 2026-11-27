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

/**
 * How to start `<file> --version`: [program, args, extra spawn options]. A .cmd or .bat shim (npm installs agents that way on
 * Windows) cannot be started without cmd.exe, so it goes through `cmd.exe /d /s /c` with one fixed, quoted command line: the
 * absolute path of the shim and `--version`, nothing else. A path with a character cmd.exe would read as syntax is not run (null).
 */
function versionCommand(file, env = process.env, platform = process.platform) {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(file)) {
    if (!/^(?:[A-Za-z]:\\|\\\\)[^"%!^&|<>\r\n\0]+$/.test(file)) return null;
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    return [root + '\\System32\\cmd.exe', ['/d', '/s', '/c', '""' + file + '" --version"'], { windowsVerbatimArguments: true }];
  }
  return [file, ['--version'], {}];
}

/** The version `<agent> --version` prints, or null. opts: env, cwd, timeoutMs, spawn (tests), platform (tests). */
function foundVersion(id, opts = {}) {
  const e = Object.hasOwn(TESTED, id) ? TESTED[id] : null;
  if (!e || !e.command) return null;
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const file = require('./../exe').findProgram(e.command, env, opts.cwd || process.cwd(), { shims: platform === 'win32' });
  if (!file) return null;
  const cmd = versionCommand(file, env, platform);
  if (!cmd) return null;
  const bare = { PATH: require('./../exe').programEnv(env, process.platform, opts.cwd || process.cwd()).PATH, HOME: env.HOME || os.homedir(), USERPROFILE: env.USERPROFILE || os.homedir(), NO_UPDATE_NOTIFIER: '1', DISABLE_AUTOUPDATER: '1', CI: '1' };
  if (platform === 'win32') {
    for (const k of ['SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA']) if (env[k]) bare[k] = env[k];
  }
  try {
    const r = (opts.spawn || spawnSync)(cmd[0], cmd[1], { ...cmd[2], env: bare, cwd: os.tmpdir(), timeout: opts.timeoutMs || 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 65536, windowsHide: true });
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
  if (!found) return { found: null, tested, relation: 'not-found' };
  const c = tested ? compareVersions(found, tested) : null;
  return { found, tested, relation: c === null ? 'unknown' : c > 0 ? 'newer' : c < 0 ? 'older' : 'same' };
}

/** The plain-language line for the report. */
function versionLine(info) {
  const tested = info.tested ? ` (tested with ${info.tested})` : '';
  if (info.relation === 'not-found') return `version: not found${tested}`;
  if (info.relation === 'same') return `version ${info.found}, the version zn was last tested with`;
  if (info.relation === 'newer') return `version ${info.found}, newer than ${info.tested}, the last version zn was tested with. It may still work. If a hook does not run, report it at https://github.com/usezn/zn/issues`;
  if (info.relation === 'older') return `version ${info.found}, older than ${info.tested}, the last version zn was tested with. If a hook does not run, update the agent first, then report it at https://github.com/usezn/zn/issues`;
  return `version ${info.found}, no tested version recorded`;
}

module.exports = { versionCommand, compareVersions, testedVersion, foundVersion, versionInfo, versionLine, TESTED };
