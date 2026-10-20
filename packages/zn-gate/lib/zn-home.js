'use strict';

const os = require('os');
const path = require('path');

/**
 * The folder where zn keeps its own state (vault, audit log, stats, pins): ZN_HOME when it is set,
 * otherwise <home>/.zn. One place, so everything that reads or protects that folder agrees on it.
 */
function znHomeDir(env = process.env, home = os.homedir()) {
  if (env.ZN_HOME) return path.resolve(env.ZN_HOME);
  return path.join(home, '.zn');
}

module.exports = { znHomeDir };
