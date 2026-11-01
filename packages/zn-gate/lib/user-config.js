'use strict';

/**
 * The one reader for the zn settings file, ~/.zn/config.json (or
 * $ZN_HOME/config.json). Every place that reads it goes through here, so an
 * unusable file gets the same treatment everywhere: the settings fall back to
 * their defaults and the problem is reported in one sentence. The file itself
 * is never changed by reading it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** The file name as the person would type it: "~/.zn/config.json" under the home folder, else the full path. */
function displayPath(file) {
  const rel = path.relative(os.homedir(), file);
  if (rel && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..') return '~/' + rel.split(path.sep).join('/');
  return file;
}

function unusable(shown, why) {
  return { config: {}, error: shown + ' ' + why + ', so zn-gate is using default settings. Fix or remove the file.' };
}

/**
 * Reads one config file. Returns {config, error}: config is the parsed object,
 * or {} when the file is missing or unusable; error is a sentence for the
 * person, or null. A missing file is not an error.
 */
function readUserConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { config: {}, error: null };
    return unusable(displayPath(file), 'cannot be read');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return unusable(displayPath(file), 'is not valid JSON');
  }
  if (parsed === null) return { config: {}, error: null };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return unusable(displayPath(file), 'is not a JSON object');
  return { config: parsed, error: null };
}

/**
 * Problems with the settings files that `zn status` and `zn check` look at:
 * the account's ~/.zn/config.json (the one the hooks read) and, when ZN_HOME
 * points somewhere else, the ZN_HOME one.
 */
function userConfigProblems(env = process.env) {
  const account = path.join(os.homedir(), '.zn', 'config.json');
  const files = [account];
  if (env.ZN_HOME) {
    const other = path.join(path.resolve(env.ZN_HOME), 'config.json');
    if (other !== account) files.push(other);
  }
  return files.map((f) => readUserConfig(f).error).filter(Boolean);
}

module.exports = { readUserConfig, userConfigProblems, displayPath };
