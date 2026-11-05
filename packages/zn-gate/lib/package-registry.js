'use strict';

/**
 * The online part of the package install check (hooks.packageInstallCheck = "online"). Loaded only in that mode.
 *
 * For each package name it makes one unauthenticated GET to the public registry the package would come from anyway:
 *   https://registry.npmjs.org/<name>      (a scoped name as @scope%2Fname)
 *   https://pypi.org/pypi/<name>/json
 * and nothing else leaves the machine: no cookies, no headers beyond Accept, no command, path, project or user data.
 * The name is validated before it is put in the URL. A redirect is never followed, a reply over 4 MiB is dropped,
 * and a lookup that has not finished in 2 seconds is given up. Any failure (network, timeout, status other than
 * 200 and 404, a reply that is not the expected JSON) gives no answer, and the caller then asks no question.
 *
 * The answers are kept for one day in ~/.zn/package-registry-cache.json (written atomically, mode 0600). A cache that
 * cannot be read or written is ignored. Only the name, whether it exists and the date of its first release are kept.
 */

const fs = require('fs');
const path = require('path');

const HOSTS = new Set(['registry.npmjs.org', 'pypi.org']);
const TIMEOUT_MS = 2000;
const MAX_BYTES = 4 * 1024 * 1024;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 2000;
const MAX_NAMES = 8;
const CACHE_FILE = 'package-registry-cache.json';
const DAY_MS = 24 * 60 * 60 * 1000;

const NPM_OK = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PYPI_OK = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** The registry URL for a validated name, or null. A scoped npm name keeps its @ and has the slash encoded. */
function urlFor(eco, name) {
  if (typeof name !== 'string' || name.length > 214) return null;
  if (eco === 'npm') return NPM_OK.test(name) ? 'https://registry.npmjs.org/' + name.replace('/', '%2F') : null;
  if (eco === 'pypi') return PYPI_OK.test(name) && name.length <= 100 ? 'https://pypi.org/pypi/' + name + '/json' : null;
  return null;
}

/* The options of the one request: certificate checks are set explicitly, so NODE_TLS_REJECT_UNAUTHORIZED in the environment cannot switch them off. */
function requestOptions(u, timeoutMs) {
  return { hostname: u.hostname, path: u.pathname, method: 'GET', agent: false, timeout: timeoutMs, rejectUnauthorized: true, headers: { Accept: 'application/json' } };
}

/* The real fetch: https.request, no redirects, no cookies, capped size, short timeout. Resolves { status, body }. */
function httpsFetch(url, { timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('bad url')); return; }
    if (u.protocol !== 'https:' || !HOSTS.has(u.hostname) || u.username || u.password) { reject(new Error('host not allowed')); return; }
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const req = https.request(requestOptions(u, timeoutMs), (res) => {
      const status = res.statusCode;
      // A redirect is not followed: it has no verdict.
      if (status !== 200 && status !== 404) { res.resume(); finish(resolve, { status, body: '' }); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => finish(resolve, { status, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => finish(reject, e));
    });
    const timer = setTimeout(() => { req.destroy(new Error('timeout')); }, timeoutMs);
   
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

/* Milliseconds of the first release in the registry's JSON, or null when it cannot be told. */
function createdOf(eco, doc) {
  const ok = (t) => (Number.isFinite(t) ? t : null);
  if (eco === 'npm') {
    const t = doc && doc.time && typeof doc.time.created === 'string' ? Date.parse(doc.time.created) : NaN;
    return ok(t);
  }
  let first = Infinity;
  const releases = doc && typeof doc.releases === 'object' && doc.releases ? doc.releases : {};
  for (const files of Object.values(releases)) {
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      if (!f || typeof f !== 'object') continue;
      let s = typeof f.upload_time_iso_8601 === 'string' ? f.upload_time_iso_8601 : typeof f.upload_time === 'string' ? f.upload_time + 'Z' : '';
      const t = Date.parse(s);
      if (Number.isFinite(t) && t < first) first = t;
    }
  }
  return first === Infinity ? null : first;
}

/* One lookup: { state: 'missing' | 'found', created } or throws an Error with a short reason. */
async function fetchOne(eco, name, fetch, timeoutMs, maxBytes) {
  const url = urlFor(eco, name);
  if (!url) throw new Error('name not valid');
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); });
  let res;
  try { res = await Promise.race([Promise.resolve().then(() => fetch(url, { timeoutMs, maxBytes })), limit]); } finally { clearTimeout(timer); }
  if (!res || typeof res.status !== 'number') throw new Error('no reply');
  if (res.status === 404) return { state: 'missing', created: null };
  if (res.status !== 200) throw new Error('status ' + res.status);
  if (typeof res.body !== 'string') throw new Error('no body');
  if (res.body.length > maxBytes) throw new Error('reply too large');
  let doc;
  try { doc = JSON.parse(res.body); } catch (e) { throw new Error('reply is not JSON'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('reply not understood');
  return { state: 'found', created: createdOf(eco, doc) };
}

function readCache(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.v === 1 && data.e && typeof data.e === 'object') return data.e;
  } catch (e) { /* no cache, or one that cannot be read */ }
  return {};
}

function writeCache(file, entries) {
  const keys = Object.keys(entries);
  if (keys.length > MAX_CACHE_ENTRIES) {
    keys.sort((a, b) => entries[a].t - entries[b].t).slice(0, keys.length - MAX_CACHE_ENTRIES).forEach((k) => { delete entries[k]; });
  }
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, e: entries }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* nothing was written */ }
  }
}

/**
 * Looks the names up. items: [{ eco, name }]. Returns a Map `eco:name` -> { state, ageDays } or { error }.
 * opts: { fetch, now (function, ms), stateDir, timeoutMs, maxBytes }
 */
async function lookupMany(items, opts = {}) {
  const fetch = typeof opts.fetch === 'function' ? opts.fetch : httpsFetch;
  const now = typeof opts.now === 'function' ? opts.now() : Date.now();
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const maxBytes = opts.maxBytes || MAX_BYTES;
  const file = opts.stateDir ? path.join(opts.stateDir, CACHE_FILE) : null;
  const cache = file ? readCache(file) : {};
  const out = new Map();
  const todo = [];
  for (const it of items.slice(MAX_NAMES)) out.set(it.eco + ':' + it.name, { error: 'too many names' });
  for (const it of items.slice(0, MAX_NAMES)) {
    const key = it.eco + ':' + it.name;
    const hit = cache[key];
    if (hit && typeof hit.t === 'number' && now - hit.t < TTL_MS && now >= hit.t && (hit.s === 'missing' || hit.s === 'found')) {
      out.set(key, { state: hit.s, ageDays: typeof hit.c === 'number' ? (now - hit.c) / DAY_MS : null });
    } else todo.push(it);
  }
  let changed = false;
  await Promise.all(todo.map(async (it) => {
    const key = it.eco + ':' + it.name;
    try {
      const r = await fetchOne(it.eco, it.name, fetch, timeoutMs, maxBytes);
      cache[key] = { t: now, s: r.state, c: r.created };
      changed = true;
      out.set(key, { state: r.state, ageDays: r.created === null ? null : (now - r.created) / DAY_MS });
    } catch (e) {
      out.set(key, { error: String((e && e.message) || 'failed').replace(/[^A-Za-z0-9 .:-]/g, '').slice(0, 60) });
    }
  }));
  if (file && changed) writeCache(file, cache);
  return out;
}

/* ------------------- another registry in the user's settings ------------------- */

function readSmall(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8', 0, n);
    } finally { fs.closeSync(fd); }
  } catch (e) { return ''; }
}

const NPM_HOST_OK = /^https?:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)(?:[/:]|$)/i;

/**
 * True when the user's own settings point the ecosystem at a registry other than the public one (an .npmrc or
 * pip.conf with another index, an environment variable, a uv or pyproject index). The public registry is then not
 * asked about that ecosystem's names: a private package name must never be sent to it. Reads settings files only
 * in online mode. opts: { cwd, home, env }.
 */
function privateRegistry(eco, opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd;
  const home = opts.home;
  if (eco === 'npm') {
    if (env.NPM_CONFIG_REGISTRY || env.npm_config_registry || env.YARN_NPM_REGISTRY_SERVER) return true;
    for (const dir of [cwd, home]) {
      if (!dir) continue;
      const text = readSmall(path.join(dir, '.npmrc')) + '\n' + readSmall(path.join(dir, '.yarnrc.yml')) + '\n' + readSmall(path.join(dir, '.yarnrc')) + '\n'
        + readSmall(path.join(dir, 'bunfig.toml')) + '\n' + readSmall(path.join(dir, '.bunfig.toml')) + '\n'
        + (env.NPM_CONFIG_USERCONFIG || env.npm_config_userconfig ? readSmall(env.NPM_CONFIG_USERCONFIG || env.npm_config_userconfig) : '');
      for (const m of text.matchAll(/^\s*(?:@[\w.-]+:)?registry\s*=\s*["']?([^\s"']+)/gim)) if (!NPM_HOST_OK.test(m[1])) return true;
      // yarn v1: registry "https://..."
      for (const m of text.matchAll(/^\s*"?(?:@[\w.-]+:)?registry"?\s+"?(https?:[^\s"]+)/gim)) if (!NPM_HOST_OK.test(m[1])) return true;
      for (const m of text.matchAll(/^\s*npmRegistryServer\s*:\s*(\S+)/gim)) if (!NPM_HOST_OK.test(m[1].replace(/['"]/g, ''))) return true;
      if (/^\s*(?:npmScopes|npmRegistries)\s*:/m.test(text)) return true;
    }
    return false;
  }
  for (const v of ['PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_FIND_LINKS', 'UV_INDEX_URL', 'UV_EXTRA_INDEX_URL', 'UV_INDEX', 'UV_DEFAULT_INDEX', 'UV_FIND_LINKS']) {
    if (env[v]) return true;
  }
  const files = [];
  if (home) files.push(path.join(home, '.config', 'pip', 'pip.conf'), path.join(home, '.pip', 'pip.conf'), path.join(home, 'pip', 'pip.ini'), path.join(home, '.config', 'uv', 'uv.toml'),
    path.join(home, 'Library', 'Application Support', 'pip', 'pip.conf'), path.join(home, 'AppData', 'Roaming', 'pip', 'pip.ini'));
  if (env.XDG_CONFIG_HOME) files.push(path.join(env.XDG_CONFIG_HOME, 'pip', 'pip.conf'), path.join(env.XDG_CONFIG_HOME, 'uv', 'uv.toml'));
  if (env.APPDATA) files.push(path.join(env.APPDATA, 'pip', 'pip.ini'));
  if (env.VIRTUAL_ENV) files.push(path.join(env.VIRTUAL_ENV, 'pip.conf'));
  for (const v of ['PIP_CONFIG_FILE', 'UV_CONFIG_FILE']) if (env[v]) files.push(env[v]);
  if (cwd) files.push(path.join(cwd, 'uv.toml'), path.join(cwd, 'pip.conf'));
  files.push('/etc/pip.conf');
  for (const f of files) if (/^\s*(?:index-url|extra-index-url|find-links|default-index|index)\b/im.test(readSmall(f))) return true;
  if (cwd && /\[\[tool\.uv\.index\]\]|^\s*(?:index-url|extra-index-url|find-links)\s*=/m.test(readSmall(path.join(cwd, 'pyproject.toml')))) return true;
  return false;
}

module.exports = { lookupMany, urlFor, httpsFetch, requestOptions, createdOf, privateRegistry, CACHE_FILE, TTL_MS, TIMEOUT_MS, MAX_BYTES };
