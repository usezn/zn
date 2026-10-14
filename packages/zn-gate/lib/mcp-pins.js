'use strict';

/**
 * Tool pinning for the MCP servers that `zn-gate shield` wraps.
 *
 * A server can change what a tool says it does after you started using it
 * (a "rug pull"): a new description that tells the model to send files
 * somewhere, or a new parameter. The shield records a SHA-256 of each tool
 * definition (the whole tool object, with sorted keys) the first time it sees
 * the server, and compares every later tools/list with those pins.
 *
 *   warn  (default) a changed or new tool stays usable; its description starts
 *         with a notice for the model, and the shield writes a warning for you.
 *         This relies on the model reading the notice.
 *   block a changed or new tool is removed from the list and calls to it are
 *         refused until you approve the change. This is the control to use.
 *   off   no pinning
 *
 * The mode is the strictest of ZN_MCP_PINNING and "mcpPinning" in
 * ~/.zn/config.json: the environment of an MCP server can raise it, never
 * lower it. Approve changes with `zn-gate pins approve` in your own terminal.
 *
 * Limits: pins cover tool definitions, not the server's code; the first list
 * of a server is trusted as it is (trust on first use); a server started as
 * `npx foo@latest` can change its code under the same pins. Pin package
 * versions in your MCP configuration.
 *
 * Pins live in ~/.zn/mcp-pins/<server>.json, one file per server, mode 0600
 * on POSIX systems. They hold the program name, its arguments with secrets
 * redacted, tool names and hashes, never tool text.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODES = ['off', 'warn', 'block']; // weakest to strictest
const MAX_NAME = 80;

/** ~/.zn, or ZN_HOME when it is inside the home directory (a folder outside it is not protected by the hooks). */
function znHome() {
  const def = path.join(os.homedir(), '.zn');
  if (!process.env.ZN_HOME) return def;
  const z = path.resolve(process.env.ZN_HOME);
  const rel = path.relative(os.homedir(), z);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return z;
  return def;
}

function pinsDir() {
  return path.join(znHome(), 'mcp-pins');
}

function modeName(m) {
  return typeof m === 'string' && MODES.includes(m.trim().toLowerCase()) ? m.trim().toLowerCase() : null;
}

/**
 * The mode: "mcpPinning" in ~/.zn/config.json (warn when it is not set), raised
 * by ZN_MCP_PINNING or the shield options when they are stricter. Only the
 * user's config can lower it, since an MCP server's environment is written in
 * project files an agent can edit.
 */
function mode(options = {}) {
  let fromConfig;
  try {
    fromConfig = JSON.parse(fs.readFileSync(path.join(znHome(), 'config.json'), 'utf8')).mcpPinning;
  } catch (_) { /* no config */ }
  let best = modeName(fromConfig) || 'warn';
  for (const m of [options.pinning, process.env.ZN_MCP_PINNING].map(modeName)) {
    if (m && MODES.indexOf(m) > MODES.indexOf(best)) best = m;
  }
  return best;
}

/** JSON with sorted object keys, so the same definition always hashes the same. */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** The whole tool object: new fields of the protocol are covered without a code change. */
function toolHash(tool) {
  return crypto.createHash('sha256').update(canonical(tool)).digest('hex');
}

/** A server name for messages: no control or format characters, bounded length. */
function displayName(name) {
  const s = String(name).replace(/[\p{C}]/gu, '?');
  return s.length > MAX_NAME ? s.slice(0, MAX_NAME) + '...' : s;
}

/** Arguments that name a file are resolved, so `node server.js` in two projects are two servers. */
function serverArgv(command, args) {
  const argv = [String(command), ...(args || []).map(String)];
  return argv.map((a, i) => {
    if (a.startsWith('-') || path.isAbsolute(a)) return a;
    if (i === 0 && !a.includes('/') && !a.includes('\\')) return a; // a program on PATH
    try {
      if (fs.statSync(path.resolve(a)).isFile()) return path.resolve(a);
    } catch (_) { /* not a file here */ }
    return a;
  });
}

function serverKey(command, args) {
  return crypto.createHash('sha256').update(JSON.stringify(serverArgv(command, args))).digest('hex').slice(0, 16);
}

/** The command for display and storage: program name and arguments with secrets redacted. */
function label(command, args) {
  const { redactSecrets } = require('./rules');
  const argv = serverArgv(command, args);
  const text = [path.basename(argv[0]), ...argv.slice(1)].join(' ');
  return displayName(redactSecrets(text).sanitized).slice(0, 200);
}

function fileOf(key) {
  return path.join(pinsDir(), key + '.json');
}

/** A server's pins, null when there are none, or { corrupt: true } when the file cannot be read as pins. */
function loadServer(key) {
  let raw;
  try {
    raw = fs.readFileSync(fileOf(key), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { corrupt: true };
  }
  try {
    const s = JSON.parse(raw);
    if (s && typeof s === 'object' && s.tools && typeof s.tools === 'object' && s.pending && typeof s.pending === 'object') return s;
  } catch (_) { /* below */ }
  return { corrupt: true };
}

function saveServer(key, s) {
  const dir = pinsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = fileOf(key);
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* renamed */ }
  }
}

/**
 * Compare one tools/list page with the pins of this server and record what
 * changed. `session.first` is set when this session pinned the server, so
 * later pages of the same session are pinned too.
 * Returns { first, flagged: Set of tool names, invalid: count }: flagged holds
 * changed, new and duplicated names; invalid counts tools without a valid name.
 */
function check(command, args, tools, session = {}) {
  const key = serverKey(command, args);
  const now = new Date().toISOString();
  const flagged = new Set();
  let invalid = 0;
  const current = {};
  const counts = {};
  for (const t of tools) {
    if (!t || typeof t !== 'object' || typeof t.name !== 'string' || !t.name) {
      invalid++;
      continue;
    }
    counts[t.name] = (counts[t.name] || 0) + 1;
    current[t.name] = toolHash(t);
  }
  for (const [name, n] of Object.entries(counts)) {
    if (n > 1) {
      flagged.add(name);
      delete current[name];
    }
  }
  let s = loadServer(key);
  if (s && s.corrupt) {
    // Never trust again silently: keep the bad file aside and treat every tool as unapproved.
    try { fs.renameSync(fileOf(key), fileOf(key) + '.corrupt-' + Date.now()); } catch (_) { /* gone */ }
    s = { command: label(command, args), pinnedAt: null, tools: {}, pending: {}, corruptAt: now };
    session.corrupt = true;
  }
  if (!s || session.first) {
    const base = s || { command: label(command, args), pinnedAt: now, tools: {}, pending: {} };
    Object.assign(base.tools, current);
    saveServer(key, base);
    if (!s) session.first = true;
    return { first: true, flagged, invalid };
  }
  let dirty = false;
  for (const [name, hash] of Object.entries(current)) {
    if (s.tools[name] === hash) {
      if (s.pending[name]) { delete s.pending[name]; dirty = true; }
      continue;
    }
    flagged.add(name);
    if (!s.pending[name] || s.pending[name].hash !== hash) {
      s.pending[name] = { hash, seenAt: now };
      dirty = true;
    }
  }
  if (dirty || session.corrupt) saveServer(key, s);
  return { first: false, flagged, invalid };
}

/** The approved names of a server, or null when the server has no pins. */
function approvedTools(command, args) {
  const s = loadServer(serverKey(command, args));
  if (!s || s.corrupt) return s && s.corrupt ? {} : null;
  const ok = {};
  for (const name of Object.keys(s.tools)) if (!s.pending[name]) ok[name] = true;
  return ok;
}

function servers() {
  let names = [];
  try {
    names = fs.readdirSync(pinsDir()).filter((n) => /^[0-9a-f]{16}\.json$/.test(n));
  } catch (_) { /* none */ }
  return names.map((n) => n.slice(0, 16));
}

/** Accept the pending changes of one server (full key) or of every server ('--all'). */
function approve(which) {
  const keys = which === '--all' ? servers() : servers().filter((k) => k === which);
  if (which !== '--all' && keys.length !== 1) return { approved: [], error: 'no server ' + displayName(which) };
  const approved = [];
  for (const k of keys) {
    const s = loadServer(k);
    if (!s || s.corrupt) continue;
    const names = Object.keys(s.pending);
    if (!names.length) continue;
    for (const n of names) s.tools[n] = s.pending[n].hash;
    s.pending = {};
    s.pinnedAt = new Date().toISOString();
    saveServer(k, s);
    approved.push({ key: k, command: s.command, tools: names.map(displayName) });
  }
  return { approved };
}

function list() {
  return servers().map((key) => {
    const s = loadServer(key);
    if (!s || s.corrupt) return { key, command: '(unreadable pins file)', pinnedAt: null, tools: 0, pending: [] };
    return { key, command: s.command, pinnedAt: s.pinnedAt, tools: Object.keys(s.tools).length, pending: Object.keys(s.pending).map(displayName) };
  });
}

module.exports = { mode, check, approve, approvedTools, list, toolHash, serverKey, label, displayName, pinsDir, canonical };
