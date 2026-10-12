#!/usr/bin/env node
'use strict';

/**
 * Pin the plugin to a published zn-gate release.
 *
 *   node plugins/tools/pin-release.js <version> [--tarball <file.tgz>]
 *
 * Downloads https://registry.npmjs.org/zn-gate/<version> metadata and the
 * release tarball (or reads a local copy with --tarball), checks the tarball
 * against the registry's sha512 integrity, and writes
 * plugins/zn-gate/scripts/zn-gate.lock.json with the SHA-256 digest of every
 * file in the package. The launcher refuses an installed zn-gate whose files
 * differ from these digests.
 *
 * Run it after the release is published, review the diff of the lock file,
 * and commit it together with the version bump of the plugin manifests.
 * No dependencies; Node.js 18 or later.
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const zlib = require('zlib');

const REGISTRY = 'https://registry.npmjs.org';
const LOCK = path.resolve(__dirname, '..', 'zn-gate', 'scripts', 'zn-gate.lock.json');

function get(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { accept: 'application/json, application/octet-stream' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (next.protocol !== 'https:') return reject(new Error('refusing non-https redirect to ' + next));
        return resolve(get(next.toString(), redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('GET ' + url + ' -> HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/*
 * Minimal reader for the ustar archives that npm pack produces: regular files,
 * directories, GNU long names (L) and PAX headers (x, g) with a path record.
 * Any other entry type (links, devices) makes the pin fail.
 */
function paxPath(body) {
  const text = body.toString('utf8');
  let off = 0;
  let found = null;
  while (off < text.length) {
    const sp = text.indexOf(' ', off);
    if (sp < 0) break;
    const len = parseInt(text.slice(off, sp), 10);
    if (!(len > 0)) throw new Error('malformed PAX header');
    const rec = text.slice(sp + 1, off + len - 1);
    const eq = rec.indexOf('=');
    if (rec.slice(0, eq) === 'path') found = rec.slice(eq + 1);
    off += len;
  }
  return found;
}

function tarEntries(buf) {
  const out = [];
  let off = 0;
  let nextName = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
    let name = field(0, 100);
    const prefix = field(345, 155);
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { nextName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x') { nextName = paxPath(body) || nextName; continue; }
    if (type === 'g') {
      if (paxPath(body)) throw new Error('global PAX header with a path is not supported');
      continue;
    }
    if (nextName) { name = nextName; nextName = null; }
    if (type === '0' || type === '\0') out.push({ name, body });
    else if (type !== '5') throw new Error('unsupported tar entry type "' + type + '" for ' + name);
  }
  return out;
}

async function main(argv) {
  const version = argv[0];
  if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('usage: pin-release.js <exact version> [--tarball <file.tgz>]');
  }
  const i = argv.indexOf('--tarball');
  const meta = JSON.parse((await get(REGISTRY + '/zn-gate/' + version)).toString('utf8'));
  if (meta.name !== 'zn-gate' || meta.version !== version) throw new Error('unexpected registry metadata');
  const integrity = meta.dist && meta.dist.integrity;
  if (!/^sha512-/.test(integrity || '')) throw new Error('the registry has no sha512 integrity for zn-gate@' + version);
  const tgz = i >= 0 ? fs.readFileSync(argv[i + 1]) : await get(meta.dist.tarball);
  const actual = 'sha512-' + crypto.createHash('sha512').update(tgz).digest('base64');
  if (actual !== integrity) throw new Error('tarball integrity mismatch: registry ' + integrity + ', file ' + actual);

  const files = {};
  for (const e of tarEntries(zlib.gunzipSync(tgz))) {
    const rel = e.name.replace(/^package\//, '');
    if (rel.includes('..') || path.isAbsolute(rel)) throw new Error('unexpected path in tarball: ' + e.name);
    if (Object.prototype.hasOwnProperty.call(files, rel)) throw new Error('duplicate path in tarball: ' + rel);
    files[rel] = crypto.createHash('sha256').update(e.body).digest('hex');
  }
  if (!files['package.json'] || !files['lib/hooks/runner.js'] || !files['lib/broker/mcp.js']) {
    throw new Error('the tarball lacks files the launcher loads');
  }
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
  const lock = {
    package: 'zn-gate',
    version,
    registry: REGISTRY,
    integrity,
    attestations: !!(meta.dist && meta.dist.attestations),
    files: sorted,
  };
  fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
  process.stdout.write('Pinned zn-gate@' + version + ' (' + Object.keys(sorted).length + ' files, provenance attestation: ' +
    (lock.attestations ? 'yes' : 'NO') + ') in ' + path.relative(process.cwd(), LOCK) + '\n');
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write('pin-release: ' + err.message + '\n');
  process.exitCode = 1;
});
