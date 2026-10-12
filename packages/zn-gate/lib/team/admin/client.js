'use strict';
/**
 * HTTP client for the zn Team admin API, authenticated with an org admin
 * token (znorg_...). The token is only ever written to the Authorization
 * header: never to an error, a log or a result. 10 s timeout, no retries
 * on POST or DELETE.
 */

const http = require('http');
const https = require('https');
const { maskTokens } = require('./token');

const TIMEOUT_MS = 10000;
const MAX_BODY = 64 * 1024 * 1024;
const CLIENT_RE = /^[A-Za-z0-9 ._/-]{1,64}$/;

class TeamApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = 'TeamApiError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra || {});
  }
}

function cleanClientPart(s) {
  const v = String(s == null ? '' : s).trim();
  return CLIENT_RE.test(v) ? v : null;
}

/** X-Zn-Client: zn-gate/<version> (<client name>/<client version>) */
function clientHeader(version, clientInfo) {
  const ver = cleanClientPart(version) || 'unknown';
  const name = clientInfo && cleanClientPart(clientInfo.name);
  const cver = clientInfo && cleanClientPart(clientInfo.version);
  return 'zn-gate/' + ver + (name ? ' (' + name + (cver ? '/' + cver : '') + ')' : '');
}

function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? '?' + s : '';
}

/**
 * createAdminClient({token, apiBase, version, clientInfo: () => ({name, version}), timeoutMs})
 */
function createAdminClient(opts) {
  const token = opts.token;
  const base = new URL(opts.apiBase);
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const clientInfo = typeof opts.clientInfo === 'function' ? opts.clientInfo : () => opts.clientInfo || null;

  function request(method, pathname, body, ro) {
    const r = ro || {};
    const url = new URL(base.pathname.replace(/\/+$/, '') + pathname, base);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {
      Authorization: 'Bearer ' + token,
      'X-Zn-Client': clientHeader(opts.version, clientInfo()),
      Accept: r.raw ? '*/*' : 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      const req = lib.request(url, { method, headers, timeout: r.timeoutMs || timeoutMs }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY) { req.destroy(); done(reject, new TeamApiError(0, 'response_too_large', 'the zn Team API response is too large')); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) {
            if (r.raw) return done(resolve, { status, headers: res.headers, body: buf });
            if (buf.length === 0) return done(resolve, {});
            try { return done(resolve, JSON.parse(buf.toString('utf8'))); } catch (_) {
              return done(reject, new TeamApiError(status, 'bad_response', 'the zn Team API returned a response that is not JSON'));
            }
          }
          let j = null;
          try { j = JSON.parse(buf.toString('utf8')); } catch (_) { j = null; }
          const code = j && typeof j.code === 'string' ? j.code : 'http_' + status;
          const message = maskTokens(String((j && (j.error || j.message)) || ('HTTP ' + status))).slice(0, 300);
          const extra = {};
          if (j && typeof j.scope === 'string') extra.scope = j.scope;
          const ra = res.headers['retry-after'];
          if (ra && /^\d{1,6}$/.test(String(ra))) extra.retryAfter = Number(ra);
          done(reject, new TeamApiError(status, code, message, extra));
        });
        res.on('error', () => done(reject, new TeamApiError(0, 'network_error', 'the connection to the zn Team API was interrupted')));
      });
      req.on('timeout', () => { req.destroy(); done(reject, new TeamApiError(0, 'timeout', 'the zn Team API did not answer in ' + Math.round((r.timeoutMs || timeoutMs) / 1000) + ' s')); });
      req.on('error', (err) => done(reject, new TeamApiError(0, 'network_error', 'could not reach the zn Team API at ' + url.origin + ' (' + (err && err.code || 'error') + ')')));
      if (payload) req.write(payload);
      req.end();
    });
  }

  const enc = encodeURIComponent;
  return {
    whoami: (ro) => request('GET', '/v1/org/whoami', undefined, ro),
    org: () => request('GET', '/v1/org'),
    installs: () => request('GET', '/v1/org/installs'),
    policy: () => request('GET', '/v1/org/policy'),
    audit: (q) => request('GET', '/v1/audit' + query(q)),
    auditSummary: (q) => request('GET', '/v1/audit/summary' + query(q)),
    auditExport: (q) => request('GET', '/v1/audit/export' + query(q), undefined, { raw: true, timeoutMs: 60000 }),
    activity: (q) => request('GET', '/v1/org/activity' + query(q)),
    changes: (q) => request('GET', '/v1/org/changes' + query(q)),
    change: (id) => request('GET', '/v1/org/changes/' + enc(id)),
    createChange: (body) => request('POST', '/v1/org/changes', body),
    confirmChange: (id, body) => request('POST', '/v1/org/changes/' + enc(id) + '/confirm', body),
    cancelChange: (id) => request('DELETE', '/v1/org/changes/' + enc(id)),
  };
}

module.exports = { createAdminClient, clientHeader, TeamApiError, TIMEOUT_MS };
