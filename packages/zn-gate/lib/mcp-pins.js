'use strict';

/**
 * Tool pinning for the MCP servers that `zn-gate shield` wraps.
 *
 * A server can change what a tool says it does after you started using it
 * (a "rug pull"): a new description that tells the model to send files
 * somewhere, or a new parameter. The shield records a SHA-256 of each tool's
 * name, description, input schema and annotations the first time it sees the
 * server, and compares every later tools/list with those pins.
 *
 *   warn  (default) a changed or new tool stays usable; its description starts
 *         with a notice for the model, and the shield writes a warning for you
 *   block a changed or new tool is removed from the list and calls to it are
 *         refused, until you approve the change
 *   off   no pinning
 *
 * Set the mode with ZN_MCP_PINNING=warn|block|off or "mcpPinning" in
 * ~/.zn/config.json. Approve changes with `zn-gate pins approve` in your own
 * terminal (the agent hooks refuse that command from an agent).
 *
 * Pins live in ~/.zn/mcp-pins.json (ZN_HOME overrides ~/.zn), mode 0600. The
 * file holds server commands, tool names and hashes, never tool text.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODES = new Set(['warn', 'block', 'off']);

function znHome() {
  if (process.env.ZN_HOME) return path.resolve(process.env.ZN_HOME);
  return path.join(os.homedir(), '.zn');
}

function pinsFile() {
  return path.join(znHome(), 'mcp-pins.json');
}

function mode(options = {}) {
  const fromOptions = options.pinning;
  const fromEnv = process.env.ZN_MCP_PINNING;
  let fromConfig;
  try {
    fromConfig = JSON.parse(fs.readFileSync(path.join(znHome(), 'config.json'), 'utf8')).mcpPinning;
  } catch (_) { /* no config */ }
  for (const m of [fromOptions, fromEnv, fromConfig]) {
    if (typeof m === 'string' && MODES.has(m.trim().toLowerCase())) return m.trim().toLowerCase();
  }
  return 'warn';
}

/** JSON with sorted object keys, so the same definition always hashes the same. */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function toolHash(tool) {
  const t = tool && typeof tool === 'object' ? tool : {};
  const def = { name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations };
  return crypto.createHash('sha256').update(canonical(def)).digest('hex');
}

/** One server is one wrapped command line. */
function serverKey(command, args) {
  return crypto.createHash('sha256').update(JSON.stringify([String(command), ...(args || []).map(String)])).digest('hex').slice(0, 16);
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(pinsFile(), 'utf8'));
    if (data && typeof data === 'object' && data.servers && typeof data.servers === 'object') return data;
  } catch (_) { /* first use or unreadable: start empty */ }
  return { version: 1, servers: {} };
}

function save(data) {
  const file = pinsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Compare a tools/list result with the pins of this server and record what
 * changed. The first list of a server is pinned as it is.
 * Returns { first, changed: [names], added: [names] }.
 */
function check(command, args, tools) {
  const data = load();
  const key = serverKey(command, args);
  const now = new Date().toISOString();
  const current = {};
  for (const t of tools) if (t && typeof t.name === 'string') current[t.name] = toolHash(t);
  const server = data.servers[key];
  if (!server) {
    data.servers[key] = { command: [String(command), ...(args || []).map(String)], pinnedAt: now, tools: current, pending: {} };
    save(data);
    return { first: true, changed: [], added: [] };
  }
  const changed = [];
  const added = [];
  const pending = {};
  for (const [name, hash] of Object.entries(current)) {
    if (!(name in server.tools)) added.push(name);
    else if (server.tools[name] !== hash) changed.push(name);
    else continue;
    pending[name] = { hash, seenAt: now };
  }
  const before = JSON.stringify(server.pending || {});
  server.pending = pending;
  if (JSON.stringify(pending) !== before) save(data);
  return { first: false, changed, added };
}

/** Accept the pending changes of one server (by key prefix) or of every server. */
function approve(which) {
  const data = load();
  const keys = Object.keys(data.servers).filter((k) => which === '--all' || k.startsWith(String(which)));
  if (which !== '--all' && keys.length !== 1) return { approved: [], error: keys.length ? 'more than one server starts with ' + which : 'no server ' + which };
  const approved = [];
  for (const k of keys) {
    const s = data.servers[k];
    const names = Object.keys(s.pending || {});
    if (!names.length) continue;
    for (const n of names) s.tools[n] = s.pending[n].hash;
    s.pending = {};
    s.pinnedAt = new Date().toISOString();
    approved.push({ key: k, command: s.command, tools: names });
  }
  if (approved.length) save(data);
  return { approved };
}

function list() {
  const data = load();
  return Object.entries(data.servers).map(([key, s]) => ({
    key, command: s.command, pinnedAt: s.pinnedAt, tools: Object.keys(s.tools || {}).length, pending: Object.keys(s.pending || {}),
  }));
}

module.exports = { mode, check, approve, list, toolHash, serverKey, pinsFile, canonical };
