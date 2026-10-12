'use strict';
/**
 * Where the zn Team org admin token lives, kept out of the model's context.
 *
 * In order of priority:
 *   1. `zn team admin login` (a person at a terminal): the token goes to the
 *      OS credential store (macOS Keychain, Windows Credential Manager,
 *      libsecret; service "zn-team-admin", account = org id), or to
 *      ~/.zn/team-admin.token (0600) when there is no store. Metadata, never
 *      the token, is in ~/.zn/team-admin.json.
 *   2. ZN_ORG_TOKEN in the environment (CI, machines without a store). If it
 *      is set in an agent's MCP configuration file, that agent can read the
 *      file: zn_status and team_whoami warn about it.
 *
 * ZN_LOCAL_ONLY=true turns the team admin tools off whatever is configured.
 * ZN_TEAM_API_URL overrides the API (https only; http://localhost and
 * http://127.0.0.1 are accepted for tests).
 */

const fs = require('fs');
const path = require('path');
const store = require('../../vault/store');
const keychain = require('../../vault/keychain');
const { parseOrgToken } = require('./token');

const SERVICE = 'zn-team-admin';
const LABEL = 'zn-team-admin-token';
const META_FILE = 'team-admin.json';
const TOKEN_FILE = 'team-admin.token';
const DEFAULT_API = 'https://api.usezn.com';
const DEFAULT_DASHBOARD = 'https://usezn.com';
const ORG_RE = /^org_[A-Za-z0-9]{8,32}$/;

function adminPaths(opts) {
  const home = store.znHome(opts);
  return { home, metaFile: path.join(home, META_FILE), tokenFile: path.join(home, TOKEN_FILE) };
}

function envOf(opts) {
  return (opts && opts.env) || process.env;
}

function localOnly(opts) {
  if (opts && opts.localOnly) return true;
  return envOf(opts).ZN_LOCAL_ONLY === 'true';
}

/** Checks an API or dashboard base URL. Returns it without a trailing slash, or throws. */
function checkBase(raw, what) {
  let u;
  try { u = new URL(String(raw)); } catch (_) { u = null; }
  const local = u && u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!u || (u.protocol !== 'https:' && !local) || u.username || u.password || u.search || u.hash) {
    const err = new Error(what + ' must be an https URL (http only for localhost)');
    err.code = 'ZN_POLICY_DENIED';
    throw err;
  }
  return u.origin + u.pathname.replace(/\/+$/, '');
}

function apiBase(opts, meta) {
  const env = envOf(opts);
  return checkBase((opts && opts.apiUrl) || env.ZN_TEAM_API_URL || (meta && meta.api_base) || DEFAULT_API, 'ZN_TEAM_API_URL');
}

function dashboardBase(opts) {
  return checkBase(envOf(opts).ZN_TEAM_DASHBOARD_URL || DEFAULT_DASHBOARD, 'ZN_TEAM_DASHBOARD_URL');
}

/**
 * Metadata written by `zn team admin login`, or null. This is the interface
 * other zn Team code reads to know which org this machine administers:
 *   {v, org_id, org_name, token_id, prefix, scopes[], expires_at, api_base, store}
 * store is "keychain:<backend>" or "file".
 */
function readAdminMeta(opts) {
  let buf;
  try { buf = store.readPrivateFile(adminPaths(opts).metaFile); } catch (_) { return null; }
  if (!buf) return null;
  let m;
  try { m = JSON.parse(buf.toString('utf8')); } catch (_) { return null; }
  if (!m || !ORG_RE.test(m.org_id || '') || !/^znorg_[A-Za-z0-9]{12}$/.test(m.prefix || '')) return null;
  if (!/^(?:keychain:(?:macos|windows|libsecret)|file)$/.test(m.store || '')) return null;
  return m;
}

function writeAdminMeta(meta, opts) {
  store.writePrivateFile(adminPaths(opts).metaFile, JSON.stringify(meta, null, 2) + '\n');
}

/**
 * Where a token would come from, without reading it: "login", "env" or
 * null. Cheap enough for every tools/list.
 */
function tokenSource(opts) {
  if (localOnly(opts)) return null;
  if (readAdminMeta(opts)) return 'login';
  if (envOf(opts).ZN_ORG_TOKEN) return 'env';
  return null;
}

/**
 * loadToken(opts) -> {token, source:'keychain'|'file'|'env', meta} or null.
 * Throws {code:'ZN_TEAM_TOKEN'} when a token is configured but unusable
 * (missing from the store, bad format or checksum). Error messages never
 * contain the token.
 */
function loadToken(opts) {
  if (localOnly(opts)) return null;
  const meta = readAdminMeta(opts);
  if (meta) {
    let token = null;
    if (meta.store === 'file') {
      let buf = null;
      try { buf = store.readPrivateFile(adminPaths(opts).tokenFile); } catch (_) { buf = null; }
      token = buf ? buf.toString('utf8').trim() : null;
    } else {
      const kc = (opts && opts.keychain) || keychain;
      try { token = kc.loadItem(meta.store.slice('keychain:'.length), { service: SERVICE, account: meta.org_id }); } catch (_) { token = null; }
    }
    if (!token) throw tokenError('the zn Team admin token is missing from the ' + (meta.store === 'file' ? 'token file' : 'OS credential store') + '; run `zn team admin login` again');
    if (!parseOrgToken(token)) throw tokenError('the stored zn Team admin token is malformed; run `zn team admin login` again');
    return { token, source: meta.store === 'file' ? 'file' : 'keychain', meta };
  }
  const env = envOf(opts).ZN_ORG_TOKEN;
  if (env) {
    const token = String(env).trim();
    if (!parseOrgToken(token)) throw tokenError('ZN_ORG_TOKEN is not a valid zn org token (expected znorg_..., checksum failed)');
    return { token, source: 'env', meta: null };
  }
  return null;
}

function tokenError(message) {
  const err = new Error(message);
  err.code = 'ZN_TEAM_TOKEN';
  return err;
}

/**
 * saveToken(token, whoami, opts) -> meta. Used by `zn team admin login`
 * after the token was checked with GET /v1/org/whoami.
 */
function saveToken(token, info, opts) {
  const parsed = parseOrgToken(token);
  if (!parsed) throw tokenError('not a valid zn org token');
  if (!ORG_RE.test(info.org_id || '')) throw tokenError('the API returned an invalid organization id');
  const kc = (opts && opts.keychain) || keychain;
  const backend = (opts && opts.backend) || kc.detectBackend();
  let where = 'file';
  // A previous login may be for another org or another store: clear it first.
  removeToken(opts);
  if (backend !== 'passphrase') {
    kc.storeItem(backend, token, { service: SERVICE, account: info.org_id, label: LABEL });
    const back = kc.loadItem(backend, { service: SERVICE, account: info.org_id });
    if (back !== token) throw tokenError('the ' + backend + ' credential store did not return the stored token');
    where = 'keychain:' + backend;
  } else {
    store.writePrivateFile(adminPaths(opts).tokenFile, token + '\n');
  }
  const meta = {
    v: 1,
    org_id: info.org_id,
    org_name: info.org_name || null,
    token_id: parsed.tokenId,
    prefix: parsed.prefix,
    scopes: Array.isArray(info.scopes) ? info.scopes.slice(0, 16) : [],
    expires_at: info.expires_at || null,
    api_base: info.api_base,
    store: where,
    saved_at: new Date().toISOString(),
  };
  writeAdminMeta(meta, opts);
  return meta;
}

/** Remove the local token and metadata. Returns true if something was removed. */
function removeToken(opts) {
  const meta = readAdminMeta(opts);
  const p = adminPaths(opts);
  let removed = false;
  if (meta && meta.store !== 'file') {
    const kc = (opts && opts.keychain) || keychain;
    try { removed = kc.removeItem(meta.store.slice('keychain:'.length), { service: SERVICE, account: meta.org_id }) || removed; } catch (_) { /* gone */ }
  }
  for (const f of [p.tokenFile, p.metaFile]) {
    try { fs.unlinkSync(f); removed = true; } catch (_) { /* absent */ }
  }
  return removed;
}

/** Warnings about how the token is configured (never the token). */
function tokenWarnings(source) {
  if (source !== 'env') return [];
  return ['The org token comes from ZN_ORG_TOKEN. If it is set in an agent MCP configuration file (.mcp.json, ~/.codex/config.toml), ' +
    'that agent can read the file. Prefer `zn team admin login`, which keeps the token in the OS credential store.'];
}

module.exports = {
  SERVICE,
  DEFAULT_API,
  adminPaths,
  apiBase,
  dashboardBase,
  checkBase,
  localOnly,
  readAdminMeta,
  writeAdminMeta,
  tokenSource,
  loadToken,
  saveToken,
  removeToken,
  tokenWarnings,
};
