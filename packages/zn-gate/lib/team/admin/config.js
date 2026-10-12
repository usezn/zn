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
 *
 * Where the token is sent: only to https://api.usezn.com, and approval links
 * only point to https://usezn.com. ZN_TEAM_API_URL / ZN_TEAM_DASHBOARD_URL
 * can only name those hosts, plus http://localhost / 127.0.0.1 / [::1] when
 * ZN_TEAM_DEV=1 (development and tests). A token stored by
 * `zn team admin login` is only ever sent to the API recorded at login: the
 * environment cannot redirect it (an agent able to edit an MCP configuration
 * file could otherwise send the token to any host).
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
const ALLOWED_API = [DEFAULT_API];
const ALLOWED_DASHBOARD = [DEFAULT_DASHBOARD];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
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

function devMode(opts) {
  return envOf(opts).ZN_TEAM_DEV === '1';
}

function deny(message) {
  const err = new Error(message);
  err.code = 'ZN_POLICY_DENIED';
  return err;
}

/**
 * Checks an API or dashboard base URL against the allow-list. Returns its
 * origin (no path, no trailing slash), or throws ZN_POLICY_DENIED.
 *   allowed  origins accepted in production
 *   dev      also accept http(s)://localhost, 127.0.0.1, [::1] (ZN_TEAM_DEV=1)
 */
function checkBase(raw, what, allowed, dev) {
  let u;
  try { u = new URL(String(raw)); } catch (_) { u = null; }
  const list = allowed || ALLOWED_API;
  const hint = what + ' must be ' + list.join(' or ') + ' (http://localhost only with ZN_TEAM_DEV=1)';
  if (!u || u.username || u.password || u.search || u.hash || !/^\/*$/.test(u.pathname)) throw deny(hint);
  const local = LOCAL_HOSTS.includes(u.hostname) && (u.protocol === 'http:' || u.protocol === 'https:');
  if (list.includes(u.origin) || (local && dev)) return u.origin;
  throw deny(hint);
}

/**
 * The API base the token is sent to.
 *   meta (token from `zn team admin login`): only meta.api_base, whatever the
 *        environment or opts.apiUrl say.
 *   otherwise: opts.apiUrl / ZN_TEAM_API_URL / the default, allow-listed.
 */
function apiBase(opts, meta) {
  const env = envOf(opts);
  const dev = devMode(opts);
  if (meta) {
    if (!meta.api_base) throw deny('the zn Team login has no API recorded; run `zn team admin login` again');
    return checkBase(meta.api_base, 'the API recorded at login', ALLOWED_API, dev);
  }
  return checkBase((opts && opts.apiUrl) || env.ZN_TEAM_API_URL || DEFAULT_API, 'ZN_TEAM_API_URL', ALLOWED_API, dev);
}

function dashboardBase(opts) {
  return checkBase(envOf(opts).ZN_TEAM_DASHBOARD_URL || DEFAULT_DASHBOARD, 'ZN_TEAM_DASHBOARD_URL', ALLOWED_DASHBOARD, devMode(opts));
}

/** True when url is an https (or, in dev mode, local) link on the dashboard origin. */
function isDashboardUrl(url, opts) {
  let u;
  try { u = new URL(String(url)); } catch (_) { return false; }
  if (u.username || u.password) return false;
  let base;
  try { base = dashboardBase(opts); } catch (_) { return false; }
  return u.origin === base && (u.protocol === 'https:' || devMode(opts));
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
  ALLOWED_API,
  ALLOWED_DASHBOARD,
  apiBase,
  dashboardBase,
  isDashboardUrl,
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
