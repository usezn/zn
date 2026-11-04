'use strict';
/**
 * `zn scan --package <name>[@version]`: download an npm package from the registry and unpack it into a
 * fresh temporary folder, so that the scan and the agent-config audit can read its files.
 *
 * Nothing in the package is run. There is no install, no lifecycle script and no require of its files:
 * the registry is read with plain HTTPS GET requests, the tarball is checked against the checksum the
 * registry gave, and the archive is unpacked by the code below (regular files and folders only; links,
 * devices and paths that leave the folder are refused).
 *
 *   parsePackageSpec(spec)  -> { name, version }            (throws PackageError)
 *   fetchPackageForScan(spec, { registry? })
 *       -> Promise<{ name, version, dir, cleanup() }>        (throws PackageError)
 *
 * The registry is https://registry.npmjs.org unless ZN_NPM_REGISTRY names another one (plain http is
 * accepted for localhost only, for tests and private mirrors on this machine).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const TIMEOUT_MS = 20000;
const MAX_METADATA_BYTES = 5 * 1024 * 1024;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const NAME_RE = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const HASH_ORDER = ['sha512', 'sha384', 'sha256', 'sha1'];

class PackageError extends Error {}

function parsePackageSpec(spec) {
  const s = String(spec || '').trim();
  const at = s.lastIndexOf('@');
  const name = at > 0 ? s.slice(0, at) : s;
  const version = at > 0 ? s.slice(at + 1) : 'latest';
  if (!s || name.length > 214 || !NAME_RE.test(name)) {
    throw new PackageError('not an npm package name: ' + JSON.stringify(s.slice(0, 80)) + ' (use NAME or @SCOPE/NAME, with an optional @VERSION)');
  }
  if (!VERSION_RE.test(version)) {
    throw new PackageError('not a version or dist-tag: ' + JSON.stringify(version.slice(0, 80)));
  }
  return { name, version };
}

function registryBase(env) {
  const raw = String(env.ZN_NPM_REGISTRY || DEFAULT_REGISTRY).replace(/\/+$/, '');
  let u;
  try { u = new URL(raw); } catch (_) { throw new PackageError('ZN_NPM_REGISTRY is not a URL'); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new PackageError('ZN_NPM_REGISTRY must be an https address (plain http is accepted for localhost only)');
  }
  return u.href.replace(/\/+$/, '');
}

// Reads a response body with a size cap; a body over the cap is refused, not cut.
async function readCapped(res, max, what) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > max) throw new PackageError(what + ' is too large to scan (over ' + Math.round(max / 1048576) + ' MiB)');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new PackageError(what + ' is too large to scan (over ' + Math.round(max / 1048576) + ' MiB)');
  return buf;
}

async function get(url, what, max) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const cause = (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.name) || 'unknown error';
    throw new PackageError('could not reach the registry for ' + what + ' (' + String(cause).slice(0, 80) + '). Nothing was scanned; try again when you are online.');
  }
  if (res.status === 404) throw new PackageError(what + ' was not found on the registry. Nothing was scanned.');
  if (!res.ok) throw new PackageError('the registry answered HTTP ' + res.status + ' for ' + what + '. Nothing was scanned.');
  return readCapped(res, max, what);
}

function checkTarballUrl(url) {
  let u;
  try { u = new URL(url); } catch (_) { throw new PackageError('the registry gave a tarball address that is not a URL'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) {
    throw new PackageError('the registry gave a tarball address that is not https');
  }
  return u.href;
}

// The checksum the registry gave: the strongest "integrity" hash, or the sha1 "shasum". Missing both: refused.
function expectedChecksum(dist) {
  const tokens = String(dist.integrity || '').split(/\s+/).filter(Boolean);
  let best = null;
  for (const t of tokens) {
    const m = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+=*)$/.exec(t);
    if (m && (best === null || HASH_ORDER.indexOf(m[1]) < HASH_ORDER.indexOf(best.algo))) best = { algo: m[1], value: m[2], base64: true };
  }
  if (best) return best;
  if (typeof dist.shasum === 'string' && /^[0-9a-f]{40}$/.test(dist.shasum)) return { algo: 'sha1', value: dist.shasum, base64: false };
  return null;
}

function verifyChecksum(buf, expected) {
  const digest = crypto.createHash(expected.algo).update(buf).digest(expected.base64 ? 'base64' : 'hex');
  if (digest !== expected.value) {
    throw new PackageError('the downloaded tarball does not match the checksum the registry gave. Nothing was scanned.');
  }
}

function cstr(buf, start, len) {
  const end = buf.indexOf(0, start);
  const stop = end === -1 || end > start + len ? start + len : end;
  return buf.toString('utf8', start, stop);
}

function octal(buf, start, len) {
  const s = cstr(buf, start, len).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new PackageError('the archive is damaged (bad header)');
  return parseInt(s, 8);
}

function parsePax(body) {
  const out = {};
  let off = 0;
  while (off < body.length) {
    const sp = body.indexOf(0x20, off);
    if (sp === -1) break;
    const len = parseInt(body.toString('utf8', off, sp), 10);
    if (!(len > 0)) break;
    const rec = body.toString('utf8', sp + 1, off + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    off += len;
  }
  return out;
}

// The path inside the package, without the leading folder npm adds (package/). Null for the root itself.
function relativePath(name) {
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new PackageError('the package has an unsafe file path: ' + JSON.stringify(name.slice(0, 80)));
  }
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) throw new PackageError('the package has a file path that leaves its folder: ' + JSON.stringify(name.slice(0, 80)));
  const rest = parts.slice(1);
  return rest.length ? rest : null;
}

/**
 * Unpacks a gzipped tarball into an empty folder. Only regular files and folders are written. A link,
 * a device or a fifo makes the whole package refused (it is not scanned, not skipped in silence).
 */
function extractTarball(gz, dest) {
  let tar;
  try {
    tar = zlib.gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (err) {
    if (err instanceof RangeError) throw new PackageError('the package is too large to scan unpacked (over ' + Math.round(MAX_UNPACKED_BYTES / 1048576) + ' MiB)');
    throw new PackageError('the tarball is not a valid gzip archive');
  }
  const root = path.resolve(dest);
  let off = 0;
  let pax = null;
  let longName = null;
  let count = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    // The checksum field counts as eight spaces.
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 0x20 : h[i];
    if (sum !== octal(h, 148, 8)) throw new PackageError('the archive is damaged (bad header checksum)');
    let name = cstr(h, 0, 100);
    if (cstr(h, 257, 6) === 'ustar') {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = prefix + '/' + name;
    }
    const size = octal(h, 124, 12);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    off += 512;
    if (off + size > tar.length) throw new PackageError('the archive is damaged (truncated entry)');
    const body = tar.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;

    if (type === 'x') { pax = parsePax(body); continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = cstr(body, 0, body.length); continue; }
    if (pax && pax.path) name = pax.path;
    if (longName) name = longName;
    pax = null;
    longName = null;

    if (++count > MAX_ENTRIES) throw new PackageError('the package has too many files to scan (over ' + MAX_ENTRIES + ')');
    const rel = relativePath(name);
    if (type !== '0' && type !== '7' && type !== '5') {
      throw new PackageError('the package contains a link or a special file (' + JSON.stringify(name.slice(0, 80)) + '). It is refused, not scanned.');
    }
    if (rel === null) continue;
    const target = path.resolve(root, ...rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new PackageError('the package has a file path that leaves its folder');
    }
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }
  }
  return { files: count };
}

/**
 * Looks the package up, downloads its tarball, checks it and unpacks it into a new temporary folder.
 * The caller scans `dir` and then calls `cleanup()`.
 */
async function fetchPackageForScan(spec, opts = {}) {
  const { name, version } = parsePackageSpec(spec);
  const base = opts.registry || registryBase(process.env);
  const encoded = name.replace('/', '%2F');
  const label = name + '@' + version;

  const doc = JSON.parse((await get(base + '/' + encoded + '/' + encodeURIComponent(version), label, MAX_METADATA_BYTES)).toString('utf8'));
  if (!doc || doc.name !== name || typeof doc.version !== 'string' || !doc.dist || typeof doc.dist.tarball !== 'string') {
    throw new PackageError('the registry gave no usable metadata for ' + label + '. Nothing was scanned.');
  }
  const expected = expectedChecksum(doc.dist);
  if (!expected) throw new PackageError('the registry gave no checksum for ' + label + '; refusing to scan an unverified tarball.');
  const tarballUrl = checkTarballUrl(doc.dist.tarball);

  const gz = await get(tarballUrl, doc.name + '@' + doc.version + ' (tarball)', MAX_TARBALL_BYTES);
  verifyChecksum(gz, expected);

  const dir = fs.mkdtempSync(path.join(opts.tmpBase || os.tmpdir(), 'zn-scan-pkg-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    extractTarball(gz, dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  return { name, version: doc.version, dir, cleanup };
}

module.exports = { PackageError, parsePackageSpec, fetchPackageForScan, extractTarball, registryBase };
