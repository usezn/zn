'use strict';

/**
 * The one place that decides which folder zn-gate keeps its state in, and which folder is the user's home.
 *
 * ZN_HOME wins when it is set to an absolute path. Otherwise the home folder (HOME, or the account's entry in
 * the password file; USERPROFILE on Windows) must be an absolute path that is not empty and not the root of the
 * disk. When no usable folder exists nothing is written anywhere: callers get a HomeError that names HOME and
 * ZN_HOME and says what to set. Nothing here runs when the module loads: a user with no home folder (a
 * container that runs as an unknown uid) can still start the command and read the message.
 */

const os = require('os');
const path = require('path');

class HomeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HomeError';
    this.code = 'ZN_HOME_INVALID';
  }
}

const HOW_TO_FIX = 'Set ZN_HOME to an absolute folder you can write, for example ZN_HOME=/workspace/.zn (or set HOME to your home folder).';

function homeVar() {
  return process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
}

function isUsable(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return false;
  if (!path.isAbsolute(dir)) return false;
  return path.resolve(dir) !== path.parse(path.resolve(dir)).root;
}

/** The account's home folder as a validated absolute path, or a HomeError. */
function homeDir() {
  let dir = '';
  let why = '';
  try {
    dir = os.homedir();
  } catch (_) {
    why = 'the system has no home folder for this user (HOME is not set and the user has no entry in /etc/passwd)';
  }
  if (!why) {
    if (typeof dir !== 'string' || !dir.trim()) why = homeVar() + ' is empty';
    else if (!path.isAbsolute(dir)) why = homeVar() + ' is a relative path (' + JSON.stringify(dir) + ')';
    else if (!isUsable(dir)) why = homeVar() + ' is the root folder (' + JSON.stringify(dir) + ')';
  }
  if (why) throw new HomeError('zn-gate cannot find a safe home folder: ' + why + ', so it did not write anything. ' + HOW_TO_FIX);
  return dir;
}

/**
 * The home folder for code that only READS or MATCHES paths (the hook policy, the scrubber, the executable check):
 * the validated home, or a folder that does not exist when there is none (a container with no home folder), so a
 * decision can still be made and nothing is ever created from it. Never use it to build a path that is written.
 */
function analysisHome() {
  try {
    return homeDir();
  } catch (e) {
    if (!(e instanceof HomeError)) throw e;
    return path.join(path.parse(process.cwd()).root, 'nonexistent');
  }
}

/**
 * The state folder for an environment: ZN_HOME when it is set, else <home>/.zn.
 * `home` is a folder the caller already has (tests, an explicit option); without it the account's home is used.
 */
function stateDir(env, home) {
  const z = (env || process.env).ZN_HOME;
  // An explicit ZN_HOME is the user's choice, so a relative one is kept and resolved against the folder the command runs in.
  if (z) return path.resolve(z);
  return path.join(home || homeDir(), '.zn');
}

/** The state folder for this process. */
function znHome() {
  return stateDir(process.env);
}

module.exports = { HomeError, homeDir, analysisHome, znHome, stateDir, isUsable };
