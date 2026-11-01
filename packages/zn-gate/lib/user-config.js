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

/** The sentence for a file that exists but cannot be used. `effect` says what zn-gate does instead. */
function describe(problem, effect) {
  return problem.shown + ' ' + problem.why + ', so zn-gate ' + effect + '. Fix or remove the file.';
}

/** {config, problem}: problem is null, or {shown, why} for a file that exists and cannot be used. */
function probe(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { config: {}, problem: null };
    return { config: {}, problem: { shown: displayPath(file), why: 'cannot be read' } };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return { config: {}, problem: { shown: displayPath(file), why: 'is not valid JSON' } };
  }
  if (parsed === null) return { config: {}, problem: null };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { config: {}, problem: { shown: displayPath(file), why: 'is not a JSON object' } };
  }
  return { config: parsed, problem: null };
}

/**
 * Reads one config file. Returns {config, error}: config is the parsed object,
 * or {} when the file is missing or unusable; error is a sentence for the
 * person, or null. A missing file is not an error.
 */
function readUserConfig(file) {
  const p = probe(file);
  return { config: p.config, error: p.problem ? describe(p.problem, 'is using default settings') : null };
}

/** Thrown by a command that would write the file when the file exists and cannot be used. */
class ConfigUnusableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigUnusableError';
    this.code = 'ZN_CONFIG_UNUSABLE';
  }
}

/**
 * Called before any write to the settings file. A missing file is fine (it is
 * created). An existing file that cannot be used is never overwritten: that
 * would throw away the person's settings. The file is not touched either way.
 */
function assertWritable(file) {
  const p = probe(file);
  if (p.problem) throw new ConfigUnusableError(describe(p.problem, 'did not change it'));
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

module.exports = { readUserConfig, assertWritable, ConfigUnusableError, userConfigProblems, displayPath };
