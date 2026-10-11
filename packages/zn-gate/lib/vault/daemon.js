'use strict';
/**
 * Vault daemon (`zn unlock` / `zn lock`), in the style of ssh-agent.
 *
 * - Holds the age identity in memory for one session: 8 h at most and
 *   30 min without requests (both configurable). On expiry or `zn lock` it
 *   drops its state, removes its socket and session key, and exits.
 * - Listens on a Unix socket (mode 0600, in ~/.zn/run, 0700) or on a
 *   Windows named pipe. Every connection must prove knowledge of the
 *   session key (~/.zn/run/session.key, 0600, random per unlock) with a
 *   mutual HMAC challenge, so a process of another user cannot use the
 *   daemon, and a client never sends anything to a squatted pipe.
 * - Newline-delimited JSON. Requests on one connection run in order; vault
 *   writes are serialised.
 * - Policy is enforced here as well as in the engine: `resolve` refuses
 *   destinations that the restoration policy withholds (network commands,
 *   MCP input, versioned files), and every resolve is audited.
 *
 * Limits (documented in the threat model): any process of the same OS user
 * that can read ~/.zn/run/session.key can talk to the daemon, exactly like
 * ssh-agent. Agent hooks deny agent tool calls that touch ~/.zn; the OS user
 * boundary is the real isolation. JS strings cannot be wiped from memory;
 * state is dropped and left to the garbage collector.
 *
 * The identity reaches the daemon process on stdin, never through argv,
 * environment variables or disk.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const store = require('./store');
const keychain = require('./keychain');
const audit = require('./audit');
const { variants } = require('../scrub/exact');
const { CODES, znError } = require('../errors');

const PROTOCOL = 1;
const DEFAULT_TTL_MS = 8 * 3600 * 1000;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const MAX_LINE = 4 * 1024 * 1024;
const MAX_VALUE = 1024 * 1024;
const MAX_DETECTED_EXACT = 256;
const TYPE_RE = /^[A-Z0-9](?:[A-Z0-9_]{0,62}[A-Z0-9])?$/;
const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TOKEN_RE = /^__ZN_([A-Z0-9](?:[A-Z0-9_]*[A-Z0-9])?)__$/;
const HOST_RE = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/;
const COMMAND_RE = /^[A-Za-z0-9_.+\-/ *]{1,128}$/;
const DENIED_RESOLVE = new Set(['bash_network', 'mcp_input', 'write_tracked']);

const { endpoint, hmac, safeEqualHex, createClient } = require('./client');

/* ------------------------------------------------------------------ */
/* Vault state                                                         */
/* ------------------------------------------------------------------ */

class VaultState {
  constructor(identity, recipient, opts) {
    this.identity = identity;
    this.recipient = recipient;
    this.opts = opts;
    this.paths = store.paths(opts);
    this.secrets = null;          // {v, auditKey, auditHead, secrets: {NAME: {...}}}
    this.projects = new Map();    // projectKey -> {data, byValue: Map}
    this.loading = new Map();     // projectKey -> Promise of the entry above
    this.dirtySecrets = false;
    this.writeChain = Promise.resolve();
  }

  serial(fn) {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.catch(() => {});
    return next;
  }

  async loadSecrets() {
    if (this.secrets) return this.secrets;
    let data = await store.readEncrypted(this.paths.secretsFile, this.identity);
    if (!data) {
      data = { v: 1, auditKey: crypto.randomBytes(32).toString('hex'), auditHead: null, secrets: {} };
      await store.writeEncrypted(this.paths.secretsFile, data, this.recipient);
    }
    if (!data.secrets || typeof data.secrets !== 'object') data.secrets = {};
    if (!/^[0-9a-f]{64}$/.test(data.auditKey || '')) data.auditKey = crypto.randomBytes(32).toString('hex');
    this.secrets = data;
    return data;
  }

  async saveSecrets() {
    if (!this.secrets) return;
    await store.writeEncrypted(this.paths.secretsFile, this.secrets, this.recipient);
    this.dirtySecrets = false;
  }

  /* One load per project even with concurrent connections. */
  loadProject(project) {
    const key = store.projectKey(project);
    if (!this.loading.has(key)) {
      const pending = this._loadProject(project, key);
      this.loading.set(key, pending);
      pending.catch(() => this.loading.delete(key));
    }
    return this.loading.get(key);
  }

  async _loadProject(project, key) {
    let p = this.projects.get(key);
    if (p) return p;
    const file = store.projectFile(project, this.opts);
    let data = await store.readEncrypted(file, this.identity);
    if (!data) data = { v: 1, created: new Date().toISOString(), counters: {}, tokens: {} };
    if (!data.counters || typeof data.counters !== 'object') data.counters = {};
    if (!data.tokens || typeof data.tokens !== 'object') data.tokens = {};
    const byValue = new Map();
    for (const [token, value] of Object.entries(data.tokens)) {
      const m = TOKEN_RE.exec(token);
      if (!m) continue;
      const type = m[1].replace(/_\d+$/, '');
      byValue.set(type + '\0' + value, token);
    }
    p = { key, file, data, byValue };
    this.projects.set(key, p);
    store.touch(file);
    return p;
  }

  knownValues() {
    const out = [];
    if (this.secrets) for (const s of Object.values(this.secrets.secrets)) if (s && s.value) out.push(s.value);
    for (const p of this.projects.values()) for (const v of Object.values(p.data.tokens)) out.push(v);
    return out;
  }

  drop() {
    this.identity = null;
    this.secrets = null;
    this.projects.clear();
    this.loading.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

function str(v, what, max) {
  if (typeof v !== 'string' || v.length === 0 || v.length > (max || MAX_VALUE)) throw znError(CODES.POLICY_DENIED, 'invalid ' + what);
  return v;
}

function cleanMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const out = {};
  if (m.type !== undefined) out.type = TYPE_RE.test(String(m.type)) ? String(m.type) : 'SECRET';
  out.mode = ['proxy', 'env', 'file', 'backup'].includes(m.mode) ? m.mode : 'env';
  out.allowHosts = Array.isArray(m.allowHosts) ? m.allowHosts.map((h) => String(h).toLowerCase()).filter((h) => HOST_RE.test(h)).slice(0, 64) : [];
  out.allowCommands = Array.isArray(m.allowCommands) ? m.allowCommands.map(String).filter((c) => COMMAND_RE.test(c)).slice(0, 64) : [];
  if (['header', 'query', 'body'].includes(m.injectAt)) out.injectAt = m.injectAt;
  out.source = typeof m.source === 'string' && /^(?:local|op:\/\/[^\s]{1,200}|bws:[^\s]{1,200}|infisical:[^\s]{1,200}|import:[^\s]{1,200})$/.test(m.source) ? m.source : 'local';
  return out;
}

/* Secret names: UPPER_SNAKE_CASE; never `<anything>_<number>` (the shape of
 * detected-value tokens) and never REDACTED_* (irreversible markers). */
function checkName(name) {
  const n = str(name, 'name', 64);
  if (!NAME_RE.test(n) || /_\d+$/.test(n) || /^REDACTED(?:_|$)/.test(n)) {
    throw znError(CODES.POLICY_DENIED, 'secret names are UPPER_SNAKE_CASE, cannot end in _<number> and cannot start with REDACTED_');
  }
  return n;
}

function normArgv0(argv0) {
  let a = String(argv0 || '').split(/[\\/]/).pop().trim();
  if (process.platform === 'win32') a = a.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '');
  if (!/^[A-Za-z0-9_.+-]{1,64}$/.test(a)) throw znError(CODES.POLICY_DENIED, 'invalid command name');
  return a;
}

function approvalKey(project, secret, argv0) {
  const s = String(secret || '');
  if (!NAME_RE.test(s)) throw znError(CODES.POLICY_DENIED, 'invalid secret name');
  return store.projectKey(String(project == null ? '' : project)) + ':' + s + ':' + normArgv0(argv0);
}

function makeOps(state, ctl) {
  const auditFile = state.paths.auditFile;

  /* Synchronous on purpose: audit.append is synchronous file I/O, so two
   * appends can never interleave and break the chain. */
  function writeAudit(event) {
    const secrets = state.secrets;
    if (!secrets) throw znError(CODES.LOCKED, 'vault locked');
    const rec = audit.append(event, { file: auditFile, key: Buffer.from(secrets.auditKey, 'hex'), knownValues: state.knownValues() });
    secrets.auditHead = { seq: rec.seq, mac: rec.mac };
    state.dirtySecrets = true;
    return rec;
  }

  return {
    async status() {
      return { unlocked: true, protocol: PROTOCOL, pid: process.pid, expiresAt: new Date(ctl.expiresAt).toISOString(), idleMs: ctl.idleMs };
    },

    async mapToken(project, type, value) {
      str(value, 'value');
      const t = String(type || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      if (!TYPE_RE.test(t)) throw znError(CODES.POLICY_DENIED, 'invalid type');
      return state.serial(async () => {
        const p = await state.loadProject(String(project == null ? '' : project));
        const key = t + '\0' + value;
        const existing = p.byValue.get(key);
        if (existing) return existing;
        const n = (Number(p.data.counters[t]) || 0) + 1;
        const token = '__ZN_' + t + '_' + n + '__';
        p.data.counters[t] = n;
        p.data.tokens[token] = value;
        p.data.lastUsed = new Date().toISOString();
        p.byValue.set(key, token);
        await store.writeEncrypted(p.file, p.data, state.recipient);
        return token;
      });
    },

    async resolve(project, token, opts) {
      const m = TOKEN_RE.exec(String(token || ''));
      if (!m) throw znError(CODES.POLICY_DENIED, 'invalid token');
      const o = opts && typeof opts === 'object' ? opts : {};
      const inner = m[1];
      if (o.destination && DENIED_RESOLVE.has(o.destination)) {
        await writeAudit({ secret: inner, mode: 'resolve', agent: o.agent, tool: o.tool, decision: 'deny', reason: 'policy:' + o.destination });
        throw znError(CODES.POLICY_DENIED, 'destination ' + o.destination + ' does not receive real values');
      }
      let value = null;
      const ordinal = /_(\d+)$/.exec(inner);
      if (ordinal) {
        const p = await state.loadProject(String(project == null ? '' : project));
        value = Object.prototype.hasOwnProperty.call(p.data.tokens, token) ? p.data.tokens[token] : null;
      } else {
        const secrets = await state.loadSecrets();
        const s = secrets.secrets[inner];
        if (s) { value = s.value; s.lastUsed = new Date().toISOString(); state.dirtySecrets = true; }
      }
      await writeAudit({ secret: inner, mode: 'resolve', agent: o.agent, tool: o.tool, decision: value === null ? 'deny' : 'allow', reason: value === null ? 'not_found' : (o.destination || 'unspecified') });
      return value;
    },

    async setSecret(name, value, meta) {
      const n = checkName(name);
      str(value, 'value');
      return state.serial(async () => {
        const secrets = await state.loadSecrets();
        const prev = secrets.secrets[n];
        secrets.secrets[n] = Object.assign(cleanMeta(meta), { value, created: prev ? prev.created : new Date().toISOString(), lastUsed: prev ? prev.lastUsed : null });
        await writeAudit({ secret: n, mode: 'set', decision: 'allow', reason: prev ? 'updated' : 'created' });
        await state.saveSecrets();
        return true;
      });
    },

    /* Change a secret's policy without touching (or reading) its value. */
    async updateSecretMeta(name, meta) {
      const n = str(name, 'name', 64);
      return state.serial(async () => {
        const secrets = await state.loadSecrets();
        const prev = secrets.secrets[n];
        if (!prev) throw znError(CODES.NOT_FOUND, 'no secret named ' + n);
        const current = { type: prev.type, mode: prev.mode, allowHosts: prev.allowHosts, allowCommands: prev.allowCommands, injectAt: prev.injectAt, source: prev.source };
        const merged = cleanMeta(Object.assign(current, meta && typeof meta === 'object' ? meta : {}));
        secrets.secrets[n] = Object.assign(merged, { value: prev.value, created: prev.created, lastUsed: prev.lastUsed || null });
        writeAudit({ secret: n, mode: 'set', decision: 'allow', reason: 'policy_updated' });
        await state.saveSecrets();
        return true;
      });
    },

    /* First-use approvals of (project, secret, command), kept in the vault. */
    /* Approved only if the stored approval names the same real executable
     * the client resolved now (exePath). A changed binary is refused. */
    async isApproved(project, secret, argv0, exePath) {
      const secrets = await state.loadSecrets();
      const rec = secrets.approvals && secrets.approvals[approvalKey(project, secret, argv0)];
      if (!rec || typeof rec !== 'object' || !rec.exe) return false;
      if (typeof exePath !== 'string' || rec.exe !== exePath) {
        writeAudit({ secret: String(secret), mode: 'env', argv0, decision: 'deny', reason: exePath ? 'exe_changed' : 'exe_not_found' });
        return false;
      }
      return true;
    },

    async recordApproval(project, secret, argv0, exePath) {
      const key = approvalKey(project, secret, argv0);
      if (typeof exePath !== 'string' || !exePath || exePath.length > 4096) {
        throw znError(CODES.NOT_FOUND, 'command not found on PATH: ' + normArgv0(argv0));
      }
      return state.serial(async () => {
        const secrets = await state.loadSecrets();
        if (!secrets.approvals || typeof secrets.approvals !== 'object') secrets.approvals = {};
        secrets.approvals[key] = { ts: new Date().toISOString(), exe: exePath };
        writeAudit({ secret: String(secret), mode: 'env', argv0, decision: 'ask:yes', reason: 'first_use_approved' });
        await state.saveSecrets();
        return true;
      });
    },

    async listSecrets() {
      const secrets = await state.loadSecrets();
      return Object.entries(secrets.secrets).map(([name, s]) => ({
        name, type: s.type || 'SECRET', mode: s.mode, allowHosts: s.allowHosts || [], allowCommands: s.allowCommands || [],
        injectAt: s.injectAt, source: s.source, lastUsed: s.lastUsed || null,
      })).sort((a, b) => a.name.localeCompare(b.name));
    },

    async removeSecret(name) {
      const n = str(name, 'name', 64);
      return state.serial(async () => {
        const secrets = await state.loadSecrets();
        if (!Object.prototype.hasOwnProperty.call(secrets.secrets, n)) return false;
        delete secrets.secrets[n];
        await writeAudit({ secret: n, mode: 'remove', decision: 'allow' });
        await state.saveSecrets();
        return true;
      });
    },

    async exactValues(project) {
      const secrets = await state.loadSecrets();
      const out = [];
      for (const [name, s] of Object.entries(secrets.secrets)) {
        // Backups (whole files kept by `zn env shadow`) are not values to search for.
        if (s && s.mode !== 'backup' && typeof s.value === 'string' && s.value.length >= 8) out.push({ name, type: s.type || 'SECRET', values: variants(s.value) });
      }
      // Values already detected in this project (most recent first): once a
      // value was found, it is caught again even where no pattern matches.
      const p = await state.loadProject(String(project == null ? '' : project));
      const entries = Object.entries(p.data.tokens).slice(-MAX_DETECTED_EXACT).reverse();
      for (const [token, value] of entries) {
        if (typeof value !== 'string' || value.length < 8) continue;
        const m = TOKEN_RE.exec(token);
        out.push({ type: m[1].replace(/_\d+$/, ''), values: variants(value) });
      }
      return out;
    },

    async audit(event) {
      writeAudit(event && typeof event === 'object' ? event : {});
      return true;
    },

    async auditVerify() {
      const secrets = await state.loadSecrets();
      const res = audit.verify({ file: auditFile, key: Buffer.from(secrets.auditKey, 'hex') });
      // Truncation check: the encrypted vault remembers the last record.
      if (res.ok && secrets.auditHead && res.records < secrets.auditHead.seq) {
        return { ok: false, records: res.records, error: 'log truncated (vault expects ' + secrets.auditHead.seq + ' records)' };
      }
      return res;
    },

    async lock() {
      setImmediate(() => ctl.shutdown('lock'));
      return true;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

/**
 * serve({identity, home, ttlMs, idleMs, onExit}) -> Promise<{address, close()}>
 * Runs the daemon in the current process (used by the detached daemon and
 * by tests).
 */
async function serve(opts) {
  const o = opts || {};
  const meta = keychain.readMeta(o);
  if (!meta) throw znError(CODES.NOT_FOUND, 'vault not initialised');
  const recipient = await store.recipientOf(o.identity);
  if (recipient !== meta.recipient) throw znError(CODES.LOCKED, 'identity does not match this vault');
  store.ensureLayout(o);
  const ep = endpoint(o);

  if (await isRunning(o)) throw znError(CODES.POLICY_DENIED, 'vault already unlocked');
  if (ep.unix) { try { fs.unlinkSync(ep.address); } catch (err) { /* stale socket */ } }

  const state = new VaultState(o.identity, recipient, o);
  await state.loadSecrets();
  store.pruneStale(o);

  const sessionKey = crypto.randomBytes(32);
  const ttlMs = o.ttlMs || DEFAULT_TTL_MS;
  const idleMs = o.idleMs || DEFAULT_IDLE_MS;
  const ctl = { expiresAt: Date.now() + ttlMs, idleMs, shutdown: null };
  const ops = makeOps(state, ctl);
  const sockets = new Set();
  let closed = false;
  let idleTimer = null;

  const server = net.createServer((socket) => handleConnection(socket));

  function bumpIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => shutdown('idle'), idleMs);
    idleTimer.unref();
  }
  const ttlTimer = setTimeout(() => shutdown('expired'), ttlMs);
  ttlTimer.unref();
  // Persist lastUsed and the audit head now and then.
  const flushTimer = setInterval(() => { if (state.dirtySecrets) state.serial(() => state.saveSecrets()).catch(() => {}); }, 60000);
  flushTimer.unref();

  async function shutdown(reason) {
    if (closed) return;
    closed = true;
    clearTimeout(ttlTimer);
    clearInterval(flushTimer);
    if (idleTimer) clearTimeout(idleTimer);
    try {
      await state.serial(async () => {
        if (state.secrets) {
          const secrets = state.secrets;
          const rec = audit.append({ mode: reason === 'lock' ? 'lock' : 'expire', decision: 'allow', reason },
            { file: state.paths.auditFile, key: Buffer.from(secrets.auditKey, 'hex') });
          secrets.auditHead = { seq: rec.seq, mac: rec.mac };
          await state.saveSecrets();
        }
      });
    } catch (err) { /* best effort */ }
    state.drop();
    sessionKey.fill(0);
    for (const s of sockets) s.destroy();
    try { fs.unlinkSync(ep.keyFile); } catch (err) { /* ignore */ }
    await new Promise((resolve) => server.close(() => resolve()));
    if (ep.unix) { try { fs.unlinkSync(ep.address); } catch (err) { /* ignore */ } }
    if (typeof o.onExit === 'function') o.onExit(reason);
  }
  ctl.shutdown = shutdown;

  function handleConnection(socket) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buf = '';
    let stage = 'hello';
    let serverNonce = null;
    let clientNonce = null;
    let chain = Promise.resolve();
    const send = (obj) => { if (!socket.destroyed) socket.write(JSON.stringify(obj) + '\n'); };

    socket.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE) { socket.destroy(); return; }
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch (err) { socket.destroy(); return; }
        if (stage === 'hello') {
          if (!msg || msg.op !== 'hello' || msg.v !== PROTOCOL || !/^[0-9a-f]{32}$/.test(msg.nonce || '')) { socket.destroy(); return; }
          clientNonce = msg.nonce;
          serverNonce = crypto.randomBytes(16).toString('hex');
          send({ ok: true, v: PROTOCOL, nonce: serverNonce, proof: hmac(sessionKey, 'zn-server', clientNonce, serverNonce) });
          stage = 'auth';
          continue;
        }
        if (stage === 'auth') {
          if (!msg || msg.op !== 'auth' || !safeEqualHex(msg.proof, hmac(sessionKey, 'zn-client', serverNonce, clientNonce))) {
            send({ ok: false, error: { code: CODES.POLICY_DENIED, message: 'authentication failed' } });
            socket.destroy();
            return;
          }
          stage = 'ready';
          send({ ok: true });
          continue;
        }
        const id = msg && msg.id;
        chain = chain.then(async () => {
          if (closed) { send({ id, ok: false, error: { code: CODES.LOCKED, message: 'vault locked' } }); return; }
          bumpIdle();
          const op = msg && typeof msg.op === 'string' && Object.prototype.hasOwnProperty.call(ops, msg.op) ? ops[msg.op] : null;
          if (!op) { send({ id, ok: false, error: { code: CODES.POLICY_DENIED, message: 'unknown operation' } }); return; }
          try {
            const result = await op(...(Array.isArray(msg.args) ? msg.args : []));
            send({ id, ok: true, result });
          } catch (err) {
            const code = err && typeof err.code === 'string' && err.code.startsWith('ZN_') ? err.code : 'ZN_ERROR';
            // Never echo arbitrary error text: it could carry a value.
            const message = err && err.code && err.code.startsWith('ZN_') ? String(err.message).slice(0, 200) : 'internal error';
            send({ id, ok: false, error: { code, message } });
          }
        });
      }
    });
  }

  // Unix: bind with a restrictive umask so the socket is never world-accessible.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    const oldMask = ep.unix ? process.umask(0o177) : null;
    server.listen(ep.address, () => {
      if (oldMask !== null) process.umask(oldMask);
      server.removeListener('error', reject);
      resolve();
    });
  }).catch((err) => {
    if (err && err.code === 'EADDRINUSE') throw znError(CODES.POLICY_DENIED, 'vault already unlocked');
    throw err;
  });
  if (ep.unix) fs.chmodSync(ep.address, 0o600);
  store.writePrivateFile(ep.keyFile, sessionKey.toString('hex'));
  bumpIdle();
  await state.serial(async () => {
    const rec = audit.append({ mode: 'unlock', decision: 'allow', reason: 'ttl:' + Math.round(ttlMs / 60000) + 'm' },
      { file: state.paths.auditFile, key: Buffer.from(state.secrets.auditKey, 'hex') });
    state.secrets.auditHead = { seq: rec.seq, mac: rec.mac };
    await state.saveSecrets();
  });

  return { address: ep.address, close: () => shutdown('lock'), expiresAt: ctl.expiresAt };
}

/* ------------------------------------------------------------------ */
/* Process management (CLI side)                                       */
/* ------------------------------------------------------------------ */

async function isRunning(opts) {
  const client = createClient(opts);
  try {
    await client.call('status', []);
    return true;
  } catch (err) {
    return false;
  } finally {
    client.close();
  }
}

/**
 * unlock({passphrase, backend, ttlMs, idleMs, home, init}) -> {pid, expiresAt, created}
 * Loads (or, with init, creates) the identity and starts the detached daemon.
 */
async function unlock(opts) {
  const o = opts || {};
  if (await isRunning(o)) throw znError(CODES.POLICY_DENIED, 'vault already unlocked');
  let created = false;
  let identity;
  if (!keychain.readMeta(o)) {
    if (o.init === false) throw znError(CODES.NOT_FOUND, 'vault not initialised');
    identity = (await keychain.initIdentity(o)).identity;
    created = true;
  } else {
    identity = await keychain.loadIdentity(o);
  }
  const args = [__filename, '--serve'];
  if (o.ttlMs) args.push('--ttl-ms', String(o.ttlMs));
  if (o.idleMs) args.push('--idle-ms', String(o.idleMs));
  const env = Object.assign({}, process.env);
  if (o.home) env.ZN_HOME = path.resolve(o.home);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
    env,
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(znError(CODES.LOCKED, 'daemon did not start in time')), 20000);
    child.once('message', (m) => {
      clearTimeout(timer);
      if (m && m.ready) resolve(m);
      else reject(znError((m && m.code) || CODES.LOCKED, (m && m.message) || 'daemon failed to start'));
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(znError(CODES.LOCKED, 'daemon exited during start (' + code + ')')); });
  });
  child.stdin.end(JSON.stringify({ identity }) + '\n');
  identity = null;
  const info = await ready;
  child.removeAllListeners('exit');
  if (child.connected) child.disconnect();
  child.unref();
  return { pid: child.pid, expiresAt: info.expiresAt, created };
}

/** lock({home}) -> true if a daemon was running. */
async function lock(opts) {
  const client = createClient(opts);
  try {
    await client.call('lock', []);
    return true;
  } catch (err) {
    if (err && err.code === CODES.LOCKED) return false;
    throw err;
  } finally {
    client.close();
  }
}

/* Detached daemon entry point: identity arrives on stdin. */
async function daemonMain(argv) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? Number(argv[i + 1]) : undefined; };
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let identity;
  try { identity = JSON.parse(input).identity; } catch (err) { identity = null; }
  input = '';
  try {
    const srv = await serve({ identity, ttlMs: opt('--ttl-ms'), idleMs: opt('--idle-ms'), onExit: () => process.exit(0) });
    identity = null;
    if (process.send) process.send({ ready: true, expiresAt: new Date(srv.expiresAt).toISOString() });
    if (process.connected) process.disconnect();
  } catch (err) {
    if (process.send) process.send({ ready: false, code: err.code || 'ZN_ERROR', message: String(err.message || err).slice(0, 200) });
    process.exit(1);
  }
}

if (require.main === module && process.argv.includes('--serve')) {
  daemonMain(process.argv.slice(2));
}

module.exports = { serve, unlock, lock, isRunning, endpoint, DEFAULT_TTL_MS, DEFAULT_IDLE_MS, PROTOCOL };
