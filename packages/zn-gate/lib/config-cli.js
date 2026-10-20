'use strict';

/**
 * zn-gate config list
 * zn-gate config get KEY
 * zn-gate config set KEY VALUE
 *
 * Reads and writes a few settings of ~/.zn/config.json. Only the keys in KEYS can
 * be changed, each with a fixed set of values. Other keys of the file are kept.
 * Setting a value that makes zn less strict is a choice for the person, in their
 * own terminal: never for an agent or a script.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// strict: the values that keep zn as strict as the default or stricter; any other
// value relaxes a check and needs a terminal.
const KEYS = {
  'hooks.stopReview': {
    values: ['warn', 'block'],
    fallback: 'warn',
    strict: ['block'],
    help: 'Codex: "block" asks the agent to rewrite a final answer that contains a secret value; "warn" only warns you.',
  },
  'hooks.replaceToolOutputOnSecret': {
    values: ['true', 'false'],
    fallback: 'false',
    strict: ['true'],
    help: 'Codex: "true" replaces a tool output that holds a real secret value.',
  },
};

const USAGE = 'Usage: zn-gate config list\n       zn-gate config get KEY\n       zn-gate config set KEY VALUE\n' +
  'Keys: ' + Object.keys(KEYS).join(', ') + '\n';

function configPath() {
  return path.join(os.homedir(), '.zn', 'config.json');
}

function readFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  if (text.trim() === '') return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error(file + ' is not valid JSON. Fix or remove it first; zn did not change it.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(file + ' does not hold a JSON object. Fix or remove it first; zn did not change it.');
  }
  return data;
}

function valueOf(data, key) {
  const [group, name] = key.split('.');
  const section = data[group];
  const raw = section && typeof section === 'object' ? section[name] : undefined;
  if (raw === undefined) return { value: KEYS[key].fallback, set: false };
  const v = String(raw).toLowerCase();
  return KEYS[key].values.includes(v) ? { value: v, set: true } : { value: KEYS[key].fallback, set: false };
}

function writeAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch (_) { /* new file */ }
  const tmp = path.join(dir, '.config.json.' + process.pid + '.tmp');
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* gone */ }
    throw e;
  }
}

function run(args, io) {
  const out = (io && io.out) || ((s) => process.stdout.write(s));
  const err = (io && io.err) || ((s) => process.stderr.write(s));
  const tty = io && io.tty !== undefined ? io.tty : Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const [sub, key, value, ...extra] = args;
  const known = (k) => Object.prototype.hasOwnProperty.call(KEYS, k);
  const bad = (msg) => { err('zn: ' + msg + '\n' + USAGE); return 2; };
  const file = configPath();

  try {
    if (sub === 'list' && args.length === 1) {
      const data = readFile(file);
      for (const k of Object.keys(KEYS)) {
        const v = valueOf(data, k);
        out(k + ' = ' + v.value + (v.set ? '' : ' (default)') + '\n    ' + KEYS[k].help + '\n');
      }
      return 0;
    }
    if (sub === 'get' && key && args.length === 2) {
      if (!known(key)) return bad('unknown key "' + key + '".');
      out(valueOf(readFile(file), key).value + '\n');
      return 0;
    }
    if (sub === 'set' && key && value !== undefined && extra.length === 0) {
      if (!known(key)) return bad('unknown key "' + key + '".');
      const v = String(value).toLowerCase();
      if (!KEYS[key].values.includes(v)) return bad('"' + value + '" is not a value of ' + key + ' (use ' + KEYS[key].values.join(' or ') + ').');
      if (!KEYS[key].strict.includes(v) && !tty) {
        err('zn: ' + key + ' = ' + v + ' makes zn less strict, so it can only be set by you, in your own terminal. Nothing was changed.\n');
        return 1;
      }
      const data = readFile(file);
      const [group, name] = key.split('.');
      if (!data[group] || typeof data[group] !== 'object' || Array.isArray(data[group])) data[group] = {};
      data[group][name] = KEYS[key].values.includes('true') ? v === 'true' : v;
      writeAtomic(file, data);
      out(key + ' = ' + v + '\n');
      return 0;
    }
  } catch (e) {
    err('zn: ' + (e && e.message ? e.message : String(e)) + '\n');
    return 1;
  }
  return bad('wrong usage.');
}

module.exports = { run, KEYS, configPath };
