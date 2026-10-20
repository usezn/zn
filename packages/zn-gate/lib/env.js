'use strict';

const os = require('os');
const path = require('path');

/** The folder zn keeps its state in: ZN_HOME when set, else ~/.zn. Evidence, stats and the vault all use this rule. */
function znHome(env = process.env) {
  if (env.ZN_HOME) return path.resolve(env.ZN_HOME);
  return path.join(os.homedir(), '.zn');
}

/**
 * One rule for ZN_VERBOSE: on only for 1, true, yes or on (any case, spaces ignored);
 * unset, empty, 0, false, no, off and anything else mean off.
 */
function isVerbose(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.ZN_VERBOSE == null ? '' : env.ZN_VERBOSE).trim());
}

/** Debug messages are shown when DEBUG is set or ZN_VERBOSE is on. */
function debugEnabled(env = process.env) {
  return Boolean(env.DEBUG) || isVerbose(env);
}

module.exports = { znHome, isVerbose, debugEnabled };
