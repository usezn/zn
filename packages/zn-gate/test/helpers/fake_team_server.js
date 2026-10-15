'use strict';
/*
 * Local stand-in for the zn cloud team endpoints, for client tests only.
 *
 * Ports the logic of the server modules to plain Node: join and signed policy
 * (orgs.ts), audit ingest (audit_svc.ts), and the canonical JSON, Ed25519
 * signature and audit MAC (contracts.mjs). Listens on 127.0.0.1 with a random
 * port. Error bodies are {error: '...'} like the real API.
 */

const http = require('http');
const crypto = require('crypto');

const DAY = 86400000;
const GENESIS = '0'.repeat(64);
const AUDIT_FIELDS = ['secret', 'mode', 'agent', 'tool', 'argv0', 'host', 'decision', 'reason'];
const EVENT_KEYS = new Set(['v', 'seq', 'ts', 'prev', 'mac', ...AUDIT_FIELDS]);
const JOIN_FIELDS = new Set(['join_token', 'install_id', 'audit_key', 'agent', 'os', 'zn_gate_version']);
const INGEST_FIELDS = new Set(['install_id', 'zn_gate_version', 'events']);
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const JOIN_TOKEN_RE = /^znj_[A-Za-z0-9]{32,64}$/;
const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTALL_TOKEN_RE = /^zni_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9]{32})$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const AUDIT_KEY_RE = /^[0-9a-f]{64}$/;
const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const OS_VALUES = new Set(['linux', 'darwin', 'win32', 'other']);
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

function randomAlnum(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += ALNUM[crypto.randomInt(ALNUM.length)];
  return out;
}

const sha256Hex = (text) => crypto.createHash('sha256').update(text).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

/* Keys sorted recursively, no whitespace (contracts.mjs canonicalJson). */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isInteger(value)) throw new Error('canonicalJson: only integers are allowed');
    if (value === undefined) throw new Error('canonicalJson: undefined is not allowed');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

/* The object the audit MAC covers: fixed key order, absent fields omitted. */
function auditMacInput(record) {
  const out = { v: record.v, seq: record.seq, ts: record.ts };
  for (const f of AUDIT_FIELDS) if (record[f] !== undefined) out[f] = record[f];
  out.prev = record.prev;
  return out;
}

function auditMac(key, record) {
  const k = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'hex');
  return crypto.createHmac('sha256', k).update(JSON.stringify(auditMacInput(record))).digest('hex');
}

/* verifyAuditBatch from contracts.mjs. head: {seq, mac} or null for a first batch. */
function verifyAuditBatch(events, key, head) {
  let prev = head ? head.mac : null;
  let seq = head ? head.seq : null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const expected = auditMac(key, e);
    if (!crypto.timingSafeEqual(Buffer.from(e.mac, 'hex'), Buffer.from(expected, 'hex'))) {
      return { ok: false, index: i, error: 'bad mac' };
    }
    if (prev !== null && e.prev !== prev) {
      return { ok: false, index: i, error: 'broken chain', expected: { seq: seq + 1, prev } };
    }
    if (seq !== null && e.seq !== seq + 1) {
      return { ok: false, index: i, error: 'bad sequence', expected: { seq: seq + 1, prev } };
    }
    if (prev === null && e.seq === 1 && e.prev !== GENESIS) return { ok: false, index: i, error: 'broken chain' };
    prev = e.mac;
    seq = e.seq;
  }
  return { ok: true, head: { seq, mac: prev } };
}

/* Test helper: a consecutive, correctly chained batch of audit records. */
function makeAuditChain({ key, count, startSeq = 1, prev = GENESIS, base = Date.UTC(2026, 9, 13, 9, 0, 0) }) {
  const out = [];
  let p = prev;
  for (let i = 0; i < count; i++) {
    const rec = {
      v: 1,
      seq: startSeq + i,
      ts: new Date(base + i * 1000).toISOString(),
      secret: 'EXAMPLE_KEY',
      mode: 'env',
      agent: 'claude-code',
      tool: 'Bash',
      argv0: 'node',
      host: 'api.example.com',
      decision: 'allow',
      reason: 'policy',
      prev: p,
    };
    rec.mac = auditMac(key, rec);
    out.push(rec);
    p = rec.mac;
  }
  return out;
}

function makeKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const raw = Buffer.from(der.subarray(der.length - 32));
  return {
    privateKey,
    publicKeyRaw: raw,
    publicKeyB64u: b64u(raw),
    kid: sha256Hex(raw).slice(0, 16),
  };
}

function isValidJoinBody(body) {
  if (!isObject(body)) return false;
  if (Object.keys(body).some((k) => !JOIN_FIELDS.has(k))) return false;
  if (typeof body.join_token !== 'string' || !JOIN_TOKEN_RE.test(body.join_token)) return false;
  if (typeof body.install_id !== 'string' || !INSTALL_ID_RE.test(body.install_id)) return false;
  if (typeof body.audit_key !== 'string' || !AUDIT_KEY_RE.test(body.audit_key)) return false;
  if (body.agent !== undefined && (typeof body.agent !== 'string' || !AGENT_RE.test(body.agent))) return false;
  if (body.os !== undefined && !OS_VALUES.has(body.os)) return false;
  if (body.zn_gate_version !== undefined && (typeof body.zn_gate_version !== 'string' || !VERSION_RE.test(body.zn_gate_version))) return false;
  return true;
}

function isValidEvent(e) {
  if (!isObject(e) || Object.keys(e).some((k) => !EVENT_KEYS.has(k))) return false;
  if (e.v !== 1 || !Number.isSafeInteger(e.seq) || e.seq < 1) return false;
  if (typeof e.ts !== 'string') return false;
  if (typeof e.prev !== 'string' || !HEX64_RE.test(e.prev)) return false;
  if (typeof e.mac !== 'string' || !HEX64_RE.test(e.mac)) return false;
  return AUDIT_FIELDS.every((f) => e[f] === undefined || typeof e[f] === 'string');
}

function isValidIngestBody(body) {
  if (!isObject(body) || Object.keys(body).some((k) => !INGEST_FIELDS.has(k))) return false;
  if (typeof body.install_id !== 'string' || !INSTALL_ID_RE.test(body.install_id)) return false;
  if (body.zn_gate_version !== undefined && (typeof body.zn_gate_version !== 'string' || !VERSION_RE.test(body.zn_gate_version))) return false;
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 500) return false;
  return body.events.every(isValidEvent);
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) {
        reject(Object.assign(new Error('too large'), { code: 'ZN_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, obj, headers = {}) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

async function startFakeTeamServer({ now = Date.now } = {}) {
  const requests = [];
  const state = {
    orgId: 'org_' + randomAlnum(16),
    orgName: 'Fake Org',
    inviter: 'Dana Admin',
    previewEnabled: true, // false: an older server without POST /v1/org/join-preview
    previewOrgName: null, // a different name in the preview than in the join (mismatch test)
    previewStatus: null, // force an HTTP status for the preview (e.g. 429, 500)
    active: true,
    policyVersion: 0,
    policyContent: null,
    joinTokens: new Map(), // sha256(join token) -> {maxUses, uses, expiresAt}
    installs: new Map(), // install_id -> {installId, auditKey, auditKeyHex, tokenHash, revoked, headSeq, headMac, events, ...}
    ...makeKeys(),
  };

  function signRaw(policy) {
    const sig = crypto.sign(null, Buffer.from(canonicalJson(policy), 'utf8'), state.privateKey);
    return { policy, signature: { alg: 'Ed25519', kid: state.kid, sig: b64u(sig) } };
  }

  function authInstall(req) {
    const header = req.headers.authorization || '';
    const m = /^Bearer (\S+)$/.exec(header);
    const parsed = m ? INSTALL_TOKEN_RE.exec(m[1]) : null;
    if (!parsed) return null;
    const inst = state.installs.get(parsed[1]);
    if (!inst || inst.revoked || !inst.tokenHash) return null;
    const want = Buffer.from(inst.tokenHash, 'hex');
    const got = Buffer.from(sha256Hex(parsed[2]), 'hex');
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    return inst;
  }

  function handlePreview(res, body) {
    if (!state.previewEnabled) return send(res, 404, { error: 'Not found' });
    if (state.previewStatus) return send(res, state.previewStatus, { error: 'forced' });
    const ok = isObject(body) && Object.keys(body).length === 1 && typeof body.join_token === 'string' && /^znj_[A-Za-z0-9]{40}$/.test(body.join_token);
    const jt = ok ? state.joinTokens.get(sha256Hex(body.join_token)) : null;
    if (!jt || jt.uses >= jt.maxUses || jt.expiresAt <= now()) {
      return send(res, 404, { error: 'This join token is invalid, expired or used up', code: 'invalid_join_token' });
    }
    if (!state.active) return send(res, 402, { error: 'This organization has no active Team subscription', code: 'no_subscription' });
    send(res, 200, { org_name: state.previewOrgName || state.orgName, invited_by: state.inviter, expires_at: new Date(jt.expiresAt).toISOString() });
  }

  function handleJoin(res, body, origin) {
    if (!isValidJoinBody(body)) return send(res, 400, { error: 'Invalid join request' });
    const tokenHash = sha256Hex(body.join_token);
    const jt = state.joinTokens.get(tokenHash);
    if (!jt || jt.uses >= jt.maxUses || jt.expiresAt <= now()) {
      return send(res, 403, { error: 'This join token is invalid, expired or used up' });
    }
    jt.uses += 1;
    if (!state.active) return send(res, 402, { error: 'This organization has no active Team subscription' });

    const existing = state.installs.get(body.install_id);
    const live = Boolean(existing && !existing.revoked);
    if (live && existing.auditKeyHex !== body.audit_key) {
      return send(res, 409, { error: 'This installation is already registered with a different audit key' });
    }
    const secret = randomAlnum(32);
    let inst;
    if (live) {
      inst = existing; // same key: keep the chain head, rotate the token
    } else {
      inst = {
        installId: body.install_id,
        auditKeyHex: body.audit_key,
        auditKey: Buffer.from(body.audit_key, 'hex'),
        headSeq: null,
        headMac: null,
        events: existing ? existing.events : [],
      };
    }
    inst.tokenHash = sha256Hex(secret);
    inst.revoked = false;
    if (body.agent !== undefined) inst.agent = body.agent;
    if (body.os !== undefined) inst.os = body.os;
    if (body.zn_gate_version !== undefined) inst.zn_gate_version = body.zn_gate_version;
    state.installs.set(body.install_id, inst);

    send(res, 201, {
      org: state.orgId,
      org_name: state.orgName,
      policy_url: `${origin}/v1/org/policy`,
      audit_url: `${origin}/v1/audit/ingest`,
      telemetry_url: `${origin}/v1/telemetry`,
      policy_public_key: { alg: 'Ed25519', kid: state.kid, key: state.publicKeyB64u },
      install_token: `zni_${body.install_id}_${secret}`,
    });
  }

  function handleGetPolicy(req, res) {
    if (!authInstall(req)) return send(res, 401, { error: 'Missing or invalid install token' });
    if (state.policyVersion === 0) return send(res, 404, { error: 'No policy published for this organization' });
    const dayStart = Math.floor(now() / DAY) * DAY;
    const day = new Date(dayStart).toISOString().slice(0, 10).replace(/-/g, '');
    const features = String(req.headers['x-zn-policy-features'] || '').split(',').map((s) => s.trim());
    const warnOk = features.includes('warn');
    const etag = `W/"${state.orgId}:${state.policyVersion}:${day}${warnOk ? ':w' : ''}"`;
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    const policy = {
      org: state.orgId,
      version: state.policyVersion,
      issued_at: new Date(dayStart).toISOString(),
      expires_at: new Date(dayStart + 7 * DAY).toISOString(),
      ...clone(state.policyContent),
    };
    // Older clients refuse a policy with a field they do not know: like the
    // zn service, drop only the `warn` field (the rule's other restrictions stay).
    if (!warnOk) policy.rules = policy.rules.map((r) => { const { warn, ...rest } = r; return rest; });
    return send(res, 200, signRaw(policy), { ETag: etag, 'Cache-Control': 'private, max-age=300' });
  }

  function handleIngest(req, res, body) {
    const inst = authInstall(req);
    if (!inst) return send(res, 401, { error: 'Missing or invalid install token' });
    if (!isValidIngestBody(body)) return send(res, 400, { error: 'Invalid audit batch' });
    if (body.install_id !== inst.installId) return send(res, 403, { error: 'install_id does not match the token' });
    if (!state.active) return send(res, 402, { error: 'This organization has no active Team subscription' });

    let events = body.events;
    const head = inst.headSeq === null ? null : { seq: inst.headSeq, mac: inst.headMac };
    // A resend that overlaps what is already stored: keep only the new tail.
    if (head && events[0].seq <= head.seq) {
      const i = events.findIndex((e) => e.seq === head.seq);
      if (i < 0 || events[i].mac !== head.mac) {
        return send(res, 409, { error: 'Batch does not continue the stored audit chain', expected: { seq: head.seq + 1, prev: head.mac } });
      }
      events = events.slice(i + 1);
      if (events.length === 0) return send(res, 200, { accepted: 0, duplicate: true, head: { seq: head.seq } });
    }
    const check = verifyAuditBatch(events, inst.auditKey, head);
    if (!check.ok) {
      const status = check.error === 'bad mac' ? 422 : 409;
      return send(res, status, { error: `Audit chain check failed: ${check.error}`, index: check.index, expected: check.expected });
    }
    const last = events[events.length - 1];
    inst.events.push(...events);
    inst.headSeq = last.seq;
    inst.headMac = last.mac;
    if (body.zn_gate_version !== undefined) inst.zn_gate_version = body.zn_gate_version;
    return send(res, 200, { accepted: events.length, head: { seq: last.seq } });
  }

  const server = http.createServer(async (req, res) => {
    let raw;
    try {
      raw = await readRaw(req);
    } catch {
      return send(res, 413, { error: 'Request body too large' });
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const headers = { ...req.headers };
    const authorized = headers.authorization !== undefined;
    delete headers.authorization;
    requests.push({ method: req.method, path: url.pathname, headers, authorized });

    const origin = `http://127.0.0.1:${server.address().port}`;
    const isPost = req.method === 'POST';
    if (isPost && url.pathname === '/v1/org/join-preview') {
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'Invalid JSON body' }); }
      return handlePreview(res, body);
    }
    if (isPost && url.pathname === '/v1/org/join') {
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'Invalid JSON body' }); }
      return handleJoin(res, body, origin);
    }
    if (req.method === 'GET' && url.pathname === '/v1/org/policy') return handleGetPolicy(req, res);
    if (isPost && url.pathname === '/v1/audit/ingest') {
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'Invalid JSON body' }); }
      return handleIngest(req, res, body);
    }
    return send(res, 404, { error: 'Not found' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    state,
    requests,
    close() {
      return new Promise((resolve) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => resolve());
      });
    },
    /** Returns a join token (znj_...). */
    createJoinToken({ maxUses = 10 } = {}) {
      const token = 'znj_' + randomAlnum(40);
      state.joinTokens.set(sha256Hex(token), { maxUses, uses: 0, expiresAt: now() + 7 * DAY });
      return token;
    },
    /** Publishes a new policy version and returns it. */
    publishPolicy({ rules = [], detectors, redaction } = {}) {
      const content = { rules: clone(rules) };
      if (Array.isArray(detectors) && detectors.length) content.detectors = clone(detectors);
      if (isObject(redaction)) content.redaction = clone(redaction);
      state.policyContent = content;
      state.policyVersion += 1;
      return state.policyVersion;
    },
    /** Revokes an installation: its token stops working at once. */
    revokeInstall(installId) {
      const inst = state.installs.get(installId);
      if (!inst) throw new Error('unknown installation');
      inst.revoked = true;
      inst.tokenHash = null;
    },
    setOrgActive(active) {
      state.active = Boolean(active);
    },
    /** Replaces the organization signing key. Returns the new kid. */
    rotateSigningKey() {
      Object.assign(state, makeKeys());
      return state.kid;
    },
    /** Signs an arbitrary policy object with the current key: {policy, signature}. */
    signRaw(policy) {
      return signRaw(policy);
    },
  };
}

module.exports = { startFakeTeamServer, canonicalJson, auditMac, makeAuditChain, GENESIS, SPKI_PREFIX };
