// Verifies the starter list of package names against the public registries.
//
//   node .github/scripts/check-package-names.mjs [--file <package-names.json>] [--min-days 365]
//                                                [--report <report.json>] [--write]
//
// For every name of the list it asks the registry the name belongs to (read-only GETs, one name at a time,
// a short pause between requests, 5 s and 4 MiB per request; a name that gave an error is retried once, and a
// reply that was too large is retried once with a larger cap):
//   npm   https://registry.npmjs.org/<name>   first release = time.created
//   PyPI  https://pypi.org/pypi/<name>/json   first release = earliest upload_time_iso_8601 over all releases
// and reports names that do not exist (missing), names whose first release is younger than --min-days (young)
// and names that still gave no answer (error). Membership in the list is a trust decision (a listed name is
// never looked up and never reported as a look-alike), so a name that is not verified must not stay on it.
// With --write the list is rewritten without those names and "how_it_was_made" records the run.
// Tests (no network): node --test .github/scripts/check-package-names.test.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_FILE = path.join(ROOT, 'packages', 'zn-gate', 'lib', 'data', 'package-names.json');
export const DEFAULT_MIN_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 4 * 1024 * 1024;
const RETRY_MAX_BYTES = 64 * 1024 * 1024;
const PAUSE_MS = 120;
const HOSTS = new Set(['registry.npmjs.org', 'pypi.org']);

const NPM_OK = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PYPI_OK = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function urlFor(eco, name) {
  if (typeof name !== 'string' || name.length > 214) return null;
  if (eco === 'npm') return NPM_OK.test(name) ? 'https://registry.npmjs.org/' + name.replace('/', '%2F') : null;
  if (eco === 'pypi') return PYPI_OK.test(name) ? 'https://pypi.org/pypi/' + name + '/json' : null;
  return null;
}

/** Milliseconds of the first release in a registry document, or null when it cannot be told. */
export function firstReleaseOf(eco, doc) {
  if (eco === 'npm') {
    const t = doc && doc.time && typeof doc.time.created === 'string' ? Date.parse(doc.time.created) : NaN;
    return Number.isFinite(t) ? t : null;
  }
  let first = Infinity;
  const releases = doc && typeof doc.releases === 'object' && doc.releases ? doc.releases : {};
  for (const files of Object.values(releases)) {
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      const t = Date.parse(f && typeof f.upload_time_iso_8601 === 'string' ? f.upload_time_iso_8601 : '');
      if (Number.isFinite(t) && t < first) first = t;
    }
  }
  return first === Infinity ? null : first;
}

/** One verdict from one reply: { state: 'ok' | 'missing' | 'young' | 'error', ageDays?, why? }. */
export function classify(eco, res, now, minDays) {
  if (!res || typeof res.status !== 'number') return { state: 'error', why: 'no reply' };
  if (res.status === 404) return { state: 'missing' };
  if (res.status !== 200) return { state: 'error', why: 'status ' + res.status };
  let doc;
  try { doc = JSON.parse(res.body); } catch (e) { return { state: 'error', why: 'reply is not JSON' }; }
  const created = firstReleaseOf(eco, doc);
  if (created === null) return { state: 'error', why: 'no first-release date' };
  const ageDays = Math.floor((now - created) / DAY_MS);
  return ageDays < minDays ? { state: 'young', ageDays } : { state: 'ok', ageDays };
}

/** The real fetch: https GET, no redirects, capped size and time. Resolves { status, body }; rejects with Error. */
export function httpsFetch(url, { timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) { reject(new Error('host not allowed')); return; }
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'GET', agent: false, timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
      const status = res.statusCode;
      if (status !== 200 && status !== 404) { res.resume(); resolve({ status, body: '' }); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function once(eco, name, fetch, now, minDays, maxBytes) {
  const url = urlFor(eco, name);
  if (!url) return { state: 'error', why: 'name not valid' };
  try { return classify(eco, await fetch(url, { timeoutMs: TIMEOUT_MS, maxBytes }), now, minDays); } catch (e) {
    return { state: 'error', why: String((e && e.message) || 'failed').replace(/[^A-Za-z0-9 .:-]/g, '').slice(0, 60) };
  }
}

/**
 * Checks every name, one at a time. opts: { fetch, now, minDays, pauseMs, sleep }.
 * Returns [{ eco, name, state, ageDays?, why? }] in the order of the input.
 */
export async function verifyNames(items, opts = {}) {
  const fetch = opts.fetch || httpsFetch;
  const now = opts.now === undefined ? Date.now() : opts.now;
  const minDays = opts.minDays === undefined ? DEFAULT_MIN_DAYS : opts.minDays;
  const pauseMs = opts.pauseMs === undefined ? PAUSE_MS : opts.pauseMs;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const out = [];
  for (const it of items) {
    let r = await once(it.eco, it.name, fetch, now, minDays, MAX_BYTES);
    if (r.state === 'error') {
      // One retry; a reply that was too large gets a larger cap (some very old packages have huge documents).
      await sleep(pauseMs * 4);
      r = await once(it.eco, it.name, fetch, now, minDays, r.why === 'too large' ? RETRY_MAX_BYTES : MAX_BYTES);
      if (r.state === 'error') r.retried = true;
    }
    out.push({ eco: it.eco, name: it.name, ...r });
    if (pauseMs) await sleep(pauseMs);
  }
  return out;
}

/** The list without the names that were not verified, sorted, and the counts. */
export function applyResults(list, results) {
  const bad = new Set(results.filter((r) => r.state !== 'ok').map((r) => r.eco + ':' + r.name));
  const next = { ...list };
  for (const eco of ['npm', 'pypi']) next[eco] = (list[eco] || []).filter((n) => !bad.has(eco + ':' + n)).sort();
  const count = (s) => results.filter((r) => r.state === s).length;
  return {
    list: next,
    counts: { checked: results.length, dropped: results.length - count('ok'), missing: count('missing'), young: count('young'), errors: count('error') },
  };
}

export function parseArgs(argv) {
  const o = { file: DEFAULT_FILE, minDays: DEFAULT_MIN_DAYS, report: null, write: false, extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') o.file = argv[++i];
    else if (a === '--min-days') o.minDays = Number(argv[++i]);
    else if (a === '--report') o.report = argv[++i];
    else if (a === '--write') o.write = true;
    else if (a === '--add') o.extra.push(argv[++i]);
    else throw new Error('unknown argument ' + a);
  }
  if (!o.file || !Number.isFinite(o.minDays) || o.minDays < 0) throw new Error('bad arguments');
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const list = JSON.parse(readFileSync(o.file, 'utf8'));
  // --add pypi:motor adds a candidate that is kept only if it passes the same check.
  for (const spec of o.extra) {
    const [eco, name] = spec.split(':');
    if (!['npm', 'pypi'].includes(eco) || !name) throw new Error('--add wants npm:<name> or pypi:<name>');
    if (!(list[eco] || []).includes(name)) list[eco] = [...(list[eco] || []), name];
  }
  const items = [];
  for (const eco of ['npm', 'pypi']) for (const name of list[eco] || []) items.push({ eco, name });
  const started = new Date();
  const results = await verifyNames(items, { minDays: o.minDays });
  const { list: next, counts } = applyResults(list, results);
  const report = { started_utc: started.toISOString(), min_days: o.minDays, counts, bad: results.filter((r) => r.state !== 'ok'), results };
  if (o.report) writeFileSync(o.report, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ counts, bad: report.bad }, null, 2));
  if (o.write) {
    const cmd = 'node .github/scripts/check-package-names.mjs --min-days ' + o.minDays + o.extra.map((x) => ' --add ' + x).join('') + ' --write';
    next.created = started.toISOString().slice(0, 10);
    next.how_it_was_made = 'Every name was checked against its registry (npm: time.created; PyPI: earliest upload) with `' + cmd + '` on '
      + started.toISOString().slice(0, 10) + ' (UTC). Kept only names that exist and whose first release is at least ' + o.minDays
      + ' days old. Checked ' + counts.checked + ', dropped ' + counts.dropped + ' (missing ' + counts.missing + ', too young ' + counts.young
      + ', no answer after one retry ' + counts.errors + ').';
    writeFileSync(o.file, JSON.stringify(next, null, 2) + '\n');
  }
  process.exitCode = counts.dropped ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(String((e && e.message) || e)); process.exit(2); });
}
