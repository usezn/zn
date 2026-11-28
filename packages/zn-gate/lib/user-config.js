'use strict';

/*
 * Reads zn-gate's own settings file (config.json in a .zn folder). A file that does not parse must not silently turn
 * the opt-in protections off: the reader still returns the defaults, but it reports the problem (so the hooks tell the
 * user and `check` fails) and recovers, conservatively, the protections the raw text switches ON.
 *
 * Recovery rule: a key from RECOVERABLE whose value is the literal `true` (or "deny" for whenUnavailable) anywhere in the
 * text turns that protection on. Text that only looks like a setting (inside a comment, say) therefore also turns it on:
 * that errs towards more protection, never less. Nothing is ever recovered that relaxes a check.
 */

const fs = require('fs');
const path = require('path');

const RECOVERABLE = ['strict', 'blockDestructiveCommands', 'checkToolOutputInstructions', 'replaceToolOutputOnSecret'];

function recoverHooks(text) {
  const hooks = {};
  for (const key of RECOVERABLE) {
    if (new RegExp('"' + key + '"\\s*:\\s*true\\b').test(text)) hooks[key] = true;
  }
  if (/"whenUnavailable"\s*:\s*"deny"/.test(text)) { hooks.whenUnavailable = 'deny'; hooks.failMode = 'closed'; }
  return hooks;
}

/**
 * {config, problem}. problem is null when the file is missing or valid; otherwise {file, error, kept} where error is the
 * parser's message (with the position) and kept lists the protections recovered from the raw text.
 */
function readConfigFile(dir) {
  const file = path.join(dir, 'config.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return { config: {}, problem: null }; // missing or unreadable as a file: unchanged behaviour
  }
  try {
    return { config: JSON.parse(text) || {}, problem: null };
  } catch (err) {
    let error = String(err && err.message ? err.message : err);
    let config = null;
    if (text.charCodeAt(0) === 0xFEFF) {
      error = 'the file starts with a byte order mark (BOM); save it as UTF-8 without BOM. ' + error;
      try { config = JSON.parse(text.slice(1)) || {}; } catch (_) { /* fall through to recovery */ }
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      const hooks = recoverHooks(text);
      config = Object.keys(hooks).length ? { hooks } : {};
    }
    const h = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
    const kept = RECOVERABLE.filter((k) => h[k] === true);
    return { config, problem: { file, error, kept } };
  }
}

/** The one-line text for the user. */
function problemText(p) {
  const kept = p.kept.length ? ' It keeps these protections on because the text switches them on: ' + p.kept.join(', ') + '.' : '';
  return 'zn: ' + p.file + ' is not valid JSON (' + p.error + '), so zn is using its defaults for it. Other settings you made there are ignored until it is fixed.' + kept + ' Run `zn-gate check` after fixing it.';
}

/** The invalid settings files of the account's .zn folder and of the ZN_HOME folder (the ones the hooks read). */
function invalidConfigs() {
  const stats = require('./stats');
  const dirs = [];
  const own = stats.userHome();
  if (own) dirs.push(own);
  const zn = stats.znHome();
  if (!own || path.resolve(zn) !== path.resolve(own)) dirs.push(zn);
  return dirs.map((d) => readConfigFile(d).problem).filter(Boolean);
}

module.exports = { readConfigFile, problemText, recoverHooks, invalidConfigs };
