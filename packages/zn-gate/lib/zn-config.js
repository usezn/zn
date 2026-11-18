'use strict';

/*
 * Reader for the person's own ~/.zn/config.json (hook settings, cloud marker, stats sharing, MCP pinning).
 *
 * It accepts what Windows tools write: a UTF-8 byte order mark, and UTF-16 (little or big endian, with a byte order
 * mark; Windows PowerShell 5.1 writes UTF-16 for `>` and `Set-Content -Encoding Unicode`). JSON with comments or
 * trailing commas is NOT accepted as valid: it is reported. A file that exists but cannot be used never turns into
 * "no settings" silently: load() returns the problems in plain words, and for a broken file it also returns the
 * protections the file asked for (`intent`), read with a lenient parser, so that a protection someone tried to
 * enable is not dropped. Settings that relax a check are never taken from a broken file.
 */

const fs = require('fs');
const path = require('path');
const { errorLine } = require('./config-parse');

const SHOWN = '~/.zn/config.json';

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The text of a config file's bytes, and how it was encoded. */
function decode(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return { text: buf.slice(3).toString('utf8'), encoding: 'utf-8-bom' };
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return { text: buf.slice(2).toString('utf16le'), encoding: 'utf-16le' };
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf-16be' };
  }
  // No byte order mark, but the first character is ASCII (a "{") followed by a zero byte: UTF-16 without a mark.
  if (buf.length >= 4 && buf[0] !== 0 && buf[1] === 0 && buf[2] !== 0 && buf[3] === 0) return { text: buf.toString('utf16le'), encoding: 'utf-16le' };
  if (buf.length >= 4 && buf[0] === 0 && buf[1] !== 0 && buf[2] === 0 && buf[3] !== 0) {
    const swapped = Buffer.from(buf);
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf-16be' };
  }
  return { text: buf.toString('utf8'), encoding: 'utf-8' };
}

/** Removes comments and trailing commas (outside strings) and says which it found. Used only to read intent and to explain. */
function lenientClean(text) {
  let noComments = '';
  let inString = false;
  let comments = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      noComments += c;
      if (c === '\\') { if (i + 1 < text.length) noComments += text[++i]; } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; noComments += c; continue; }
    if (c === '/' && text[i + 1] === '/') {
      comments = true;
      while (i < text.length && text[i] !== '\n') i++;
      noComments += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      comments = true;
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      noComments += ' ';
      continue;
    }
    noComments += c;
  }
  let out = '';
  let trailing = false;
  inString = false;
  for (let i = 0; i < noComments.length; i++) {
    const c = noComments[i];
    if (inString) {
      out += c;
      if (c === '\\') { if (i + 1 < noComments.length) out += noComments[++i]; } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j++;
      if (noComments[j] === '}' || noComments[j] === ']') { trailing = true; continue; }
    }
    out += c;
  }
  return { text: out, comments, trailing };
}

/**
 * Reads one JSON file that must hold an object.
 * -> {status: 'missing'} | {status: 'ok', data, encoding} | {status: 'invalid', reason, intent}
 * `intent` is the object a lenient reading of the file gives (comments and trailing commas removed), or null.
 */
function readJsonFile(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { status: 'missing' };
    return { status: 'invalid', reason: 'the file could not be read (' + ((err && err.code) || 'error') + ')', intent: null };
  }
  const { text, encoding } = decode(buf);
  if (!text.trim()) return { status: 'invalid', reason: 'the file is empty', intent: null };
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const clean = lenientClean(text);
    const causes = [];
    if (clean.comments) causes.push('it has comments, which JSON does not allow');
    if (clean.trailing) causes.push('it has a trailing comma, which JSON does not allow');
    let intent = null;
    try { const j = JSON.parse(clean.text); intent = isObj(j) ? j : null; } catch (_) { /* not readable even leniently */ }
    if (!causes.length) {
      const line = errorLine(text, err);
      causes.push('it is not valid JSON' + (line === null ? '' : ' (line ' + line + ')'));
    }
    return { status: 'invalid', reason: causes.join(' and '), intent };
  }
  if (!isObj(data)) return { status: 'invalid', reason: 'its top level must be a JSON object, in braces', intent: null };
  return { status: 'ok', data, encoding };
}

/**
 * For a command that is about to write the file: the object in it ({} when the file is missing).
 * A file that exists but cannot be read (broken JSON, comments, a trailing comma, empty, not an object) must never be
 * replaced by a fresh one: that would drop the person's settings. It throws an error with code ZN_CONFIG_UNREADABLE
 * and leaves the file as it is. A file with a byte order mark or in UTF-16 reads fine and is accepted; the writers
 * save it back as plain UTF-8 (no mark) with every setting kept.
 */
function readForWrite(file) {
  const r = readJsonFile(file);
  if (r.status === 'missing') return {};
  if (r.status === 'ok') return r.data;
  const e = new Error(unreadableMessage(r.reason));
  e.code = 'ZN_CONFIG_UNREADABLE';
  throw e;
}

function unreadableMessage(reason) {
  return SHOWN + ' could not be read (' + reason + '). zn left it as it is. Fix or remove it, then run the command again. More: https://usezn.com/docs/zn-gate/troubleshooting/';
}

/** The object in the file, {} when it is missing or unusable. For readers of settings that only add or describe. */
function readObject(file) {
  const r = readJsonFile(file);
  return r.status === 'ok' ? r.data : {};
}

// The hook settings whose type is checked. `raise`: the key adds protection, so the text "true" is read as true.
const HOOK_KEYS = {
  blockDestructiveCommands: { types: ['boolean', 'array'], expect: 'true, false or a list of rule names', raise: true },
  strict: { types: ['boolean'], expect: 'true or false', raise: true },
  replaceToolOutputOnSecret: { types: ['boolean'], expect: 'true or false', raise: true },
  checkToolOutputInstructions: { types: ['boolean'], expect: 'true or false', raise: true },
  cloudCheckToolOutput: { types: ['boolean'], expect: 'true or false' },
  stopReview: { types: ['string'], expect: 'a word in quotes' },
  whenUnavailable: { types: ['string'], expect: 'a word in quotes ("deny" or "allow")', raise: false },
  failMode: { types: ['string'], expect: 'a word in quotes' },
  agentInstructionWrites: { types: ['string', 'false'], expect: '"ask", "deny" or "off"', trueIs: 'deny' },
  egressCheck: { types: ['string', 'false'], expect: '"ask", "deny" or "off"', trueIs: 'deny' },
  egressAllowHosts: { types: ['array'], expect: 'a list of host names' },
};

function typeName(v) {
  return v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'string' ? 'text' : typeof v === 'boolean' ? 'a true/false value' : typeof v === 'number' ? 'a number' : 'an object';
}

function typeOk(spec, v) {
  return spec.types.some((t) => (t === 'array' ? Array.isArray(v) : t === 'false' ? v === false : t === 'string' ? typeof v === 'string' : typeof v === t));
}

/**
 * The hooks object with wrong-typed values repaired toward the stricter reading or dropped, and a sentence for each.
 * A value that raises protection and is written as the text "true" is read as true; any other wrong value is ignored
 * (the default applies, which is never weaker than the setting would have been when it relaxes).
 */
function sanitizeHooks(hooks) {
  const out = {};
  const problems = [];
  for (const [key, v] of Object.entries(hooks)) {
    const spec = HOOK_KEYS[key];
    if (!spec || typeOk(spec, v)) { out[key] = v; continue; }
    const isTrueText = typeof v === 'string' && v.trim().toLowerCase() === 'true';
    if (spec.raise && isTrueText) {
      out[key] = true;
      problems.push('"' + key + '" is the text "true" in quotes; zn read it as true. Write it without quotes.');
    } else if (spec.trueIs && v === true) {
      out[key] = spec.trueIs;
      problems.push('"' + key + '" is true, but it takes ' + spec.expect + '; zn read it as "' + spec.trueIs + '".');
    } else {
      problems.push('"' + key + '" is ' + typeName(v) + ' but must be ' + spec.expect + '; zn ignored it and used the default.');
    }
  }
  return { hooks: out, problems };
}

/** The settings of a parsed config object with the hooks section checked. */
function sanitize(cfg) {
  const problems = [];
  const data = Object.assign({}, cfg);
  if ('hooks' in cfg) {
    if (isObj(cfg.hooks)) {
      const r = sanitizeHooks(cfg.hooks);
      data.hooks = r.hooks;
      problems.push(...r.problems);
    } else {
      delete data.hooks;
      problems.push('"hooks" must be an object in braces; zn ignored it and used the defaults.');
    }
  }
  return { data, problems };
}

/**
 * load(dir) reads dir/config.json.
 * -> {file, status: 'missing'|'ok'|'invalid', data, intent, problems: [sentence]}
 * data: the settings to use ({} for a missing or broken file). intent: for a broken file, the hooks section a lenient
 * reading gave (types repaired), of which the caller may take only what adds protection; otherwise null.
 */
function load(dir) {
  const file = path.join(dir, 'config.json');
  const r = readJsonFile(file);
  if (r.status === 'missing') return { file, status: 'missing', data: {}, intent: null, problems: [] };
  if (r.status === 'invalid') {
    let intent = null;
    if (r.intent && isObj(r.intent.hooks)) intent = sanitizeHooks(r.intent.hooks).hooks;
    return {
      file,
      status: 'invalid',
      data: {},
      intent,
      problems: [SHOWN + ' cannot be read: ' + r.reason + '. zn did not apply it' + (intent ? ' (only the settings in it that add protection were kept)' : ' and used its defaults') + '. Save it as plain JSON (UTF-8, no comments, no trailing commas).'],
    };
  }
  const s = sanitize(r.data);
  return { file, status: 'ok', data: s.data, intent: null, problems: s.problems, encoding: r.encoding };
}

/** One message for the person from a list of problems, or null when there are none. */
function notice(problems) {
  if (!problems || !problems.length) return null;
  return 'zn: there is a problem with your settings file. ' + problems.join(' ') + ' Run `zn-gate status` to see it again.';
}

module.exports = { decode, lenientClean, readJsonFile, readObject, readForWrite, unreadableMessage, sanitizeHooks, sanitize, load, notice, SHOWN };
