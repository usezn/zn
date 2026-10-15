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
 * It also writes plugins/zn-gate/package.json and package-lock.json, from
 * which Claude Code installs that exact release into the plugin's own
 * node_modules when the plugin is installed (the launcher then checks that
 * copy against zn-gate.lock.json like any other). zn-gate's bundled
 * dependencies are listed as the plugin's own dependencies; npm writes the
 * lock (it needs npm on PATH), and the "inBundle" entries are then removed:
 * Claude Code rejects those, and without the bundled packages listed npm ci
 * fails.
 *
 * Run it after the release is published, review the diff of the lock files,
 * and commit them together with the version bump of the plugin manifests.
 * No dependencies; Node.js 18 or later.
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');
const zlib = require('zlib');

const REGISTRY = 'https://registry.npmjs.org';
const PLUGIN = path.resolve(__dirname, '..', 'zn-gate');
const LOCK = path.join(PLUGIN, 'scripts', 'zn-gate.lock.json');
const NPM_NAME = 'zn-gate-plugin';

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
function paxRecords(body) {
  // Record lengths count bytes, so the records are cut from the buffer, not from decoded text.
  const out = {};
  let off = 0;
  while (off < body.length) {
    const sp = body.indexOf(0x20, off);
    if (sp < 0) break;
    const len = parseInt(body.subarray(off, sp).toString('ascii'), 10);
    if (!(len > 0) || off + len > body.length) throw new Error('malformed PAX header');
    const rec = body.subarray(sp + 1, off + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq < 0) throw new Error('malformed PAX header');
    out[rec.slice(0, eq)] = rec.slice(eq + 1);
    off += len;
  }
  return out;
}

function paxPath(body) {
  const rec = paxRecords(body);
  if ('size' in rec) throw new Error('PAX size records are not supported');
  return rec.path || null;
}

function tarEntries(buf) {
  const out = [];
  let off = 0;
  let nextName = null;
  let ended = false;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) { ended = true; break; }
    const field = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
    let name = field(0, 100);
    const prefix = field(345, 155);
    if (prefix) name = prefix + '/' + name;
    const sizeField = field(124, 12).trim() || '0';
    if (!/^[0-7]+$/.test(sizeField)) throw new Error('unsupported size field in tar entry ' + name);
    const size = parseInt(sizeField, 8);
    if (off + 512 + size > buf.length) throw new Error('truncated tar entry ' + name);
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
  if (!ended) throw new Error('the tar archive has no end marker (truncated?)');
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
  const bundled = new Map();  // name -> version, from node_modules/*/package.json in the tarball
  for (const e of tarEntries(zlib.gunzipSync(tgz))) {
    const rel = e.name.replace(/^package\//, '');
    if (rel.includes('..') || path.isAbsolute(rel)) throw new Error('unexpected path in tarball: ' + e.name);
    if (Object.prototype.hasOwnProperty.call(files, rel)) throw new Error('duplicate path in tarball: ' + rel);
    files[rel] = crypto.createHash('sha256').update(e.body).digest('hex');
    // Only the top level of zn-gate's node_modules: nested copies stay inside the bundle.
    const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(rel);
    if (m) {
      const v = JSON.parse(e.body.toString('utf8')).version;
      if (bundled.has(m[1]) && bundled.get(m[1]) !== v) throw new Error('two versions of bundled ' + m[1] + ' in the tarball');
      bundled.set(m[1], v);
    }
  }
  if (!files['package.json'] || !files['lib/hooks/runner.js'] || !files['lib/broker/mcp.js'] || !files['lib/mcp.js']) {
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
  // Everything is computed before anything is written, so a failure leaves the plugin unchanged.
  const npm = buildNpmFiles(version, meta, bundled);
  const previous = fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, 'utf8')).version : null;
  const texts = versionedTexts(previous, version);
  for (const [file, text] of texts) fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(PLUGIN, 'package.json'), JSON.stringify(npm.pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(PLUGIN, 'package-lock.json'), JSON.stringify(npm.npmLock, null, 2) + '\n');
  fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
  process.stdout.write('Wrote plugins/zn-gate/package.json and package-lock.json (zn-gate ' + version + ', ' +
    (Object.keys(npm.npmLock.packages).length - 1) + ' packages)\n');
  if (texts.length) {
    process.stdout.write('Moved ' + texts.length + ' plugin manifest and documentation file(s) from ' + previous + ' to ' + version + '\n');
  }
  process.stdout.write('Pinned zn-gate@' + version + ' (' + Object.keys(sorted).length + ' files, provenance attestation: ' +
    (lock.attestations ? 'yes' : 'NO') + ') in ' + path.relative(process.cwd(), LOCK) + '\n');
}

/*
 * The pin, the plugin manifests, the MCP Registry entry and the version named
 * in the plugin docs change in the same commit: the plugin repository is
 * generated from the commit that last changed the pin, and its checks expect
 * every one of them to name that version. Returns [file, new text] pairs.
 */
const VERSIONED_JSON = [
  ['zn-gate/plugin.json', ['version']],
  ['zn-gate/.claude-plugin/plugin.json', ['version']],
  ['zn-gate/.cursor-plugin/plugin.json', ['version']],
  ['mcp-registry/server.json', ['version', 'packages.0.version']],
];
// Only docs that name the version the plugin installs: a sentence about an older
// release written as "zn-gate X" in one of these files would be moved too.
const VERSIONED_DOCS = ['README.md', 'zn-gate/README.md', 'zn-gate/plugin.json', 'zn-gate/.cursor-plugin/plugin.json',
  'zn-gate/.claude-plugin/plugin.json'];

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function versionedTexts(previous, version) {
  if (previous && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(previous)) throw new Error('the current pin has an unexpected version: ' + previous);
  if (!previous || previous === version) return [];
  const root = path.join(PLUGIN, '..');
  const out = new Map();
  const read = (rel) => (out.has(rel) ? out.get(rel) : fs.readFileSync(path.join(root, rel), 'utf8'));
  for (const [rel, keys] of VERSIONED_JSON) {
    if (!fs.existsSync(path.join(root, rel))) continue;
    const text = read(rel);
    const data = JSON.parse(text);
    for (const key of keys) {
      const parts = key.split('.');
      let obj = data;
      for (const k of parts.slice(0, -1)) obj = obj[/^\d+$/.test(k) ? Number(k) : k];
      obj[parts[parts.length - 1]] = version;
    }
    // Keep the file's own layout: only the version values change.
    const re = new RegExp('("version"\\s*:\\s*)"' + escapeRegExp(previous) + '"', 'g');
    const next = text.replace(re, '$1"' + version + '"');
    if (JSON.stringify(JSON.parse(next)) !== JSON.stringify(data)) throw new Error(rel + ': could not move the version in place');
    out.set(rel, next);
  }
  const esc = escapeRegExp(previous);
  const forms = [
    [new RegExp('(github\\.com/usezn/zn/(?:tree|blob)/)v' + esc + '/', 'g'), '$1v' + version + '/'],
    [new RegExp('zn-gate@' + esc + '(?![0-9]|\\.[0-9])', 'g'), 'zn-gate@' + version],
    [new RegExp('zn-gate ' + esc + '(?![0-9]|\\.[0-9])', 'g'), 'zn-gate ' + version],
    [new RegExp('\\*\\*' + esc + '\\*\\*', 'g'), '**' + version + '**'],
    [new RegExp('version ' + esc + '(?![0-9]|\\.[0-9])', 'g'), 'version ' + version],
    [new RegExp('usezn/zn@v' + esc + '(?![0-9]|\\.[0-9])', 'g'), 'usezn/zn@v' + version],
    [new RegExp('--ref v' + esc + '(?![0-9]|\\.[0-9])', 'g'), '--ref v' + version],
    [new RegExp('`v' + esc + '`', 'g'), '`v' + version + '`'],
  ];
  const skills = path.join(root, 'zn-gate', 'skills');
  const docs = [...VERSIONED_DOCS];
  if (fs.existsSync(skills)) {
    for (const d of fs.readdirSync(skills)) if (fs.existsSync(path.join(skills, d, 'SKILL.md'))) docs.push('zn-gate/skills/' + d + '/SKILL.md');
  }
  for (const rel of docs) {
    if (!fs.existsSync(path.join(root, rel))) continue;
    let text = read(rel);
    for (const [re, to] of forms) text = text.replace(re, to);
    out.set(rel, text);
  }
  return [...out].filter(([rel, text]) => text !== fs.readFileSync(path.join(root, rel), 'utf8'))
    .map(([rel, text]) => [path.join(root, rel), text]);
}

/*
 * npm resolves the plugin's lock (nested copies included) from the registry;
 * then the "inBundle" entries under node_modules/zn-gate are removed, since
 * those files come from the zn-gate tarball itself.
 */
function stripBundled(npmLock) {
  for (const k of Object.keys(npmLock.packages)) {
    if (k.startsWith('node_modules/zn-gate/node_modules/') || npmLock.packages[k].inBundle) delete npmLock.packages[k];
  }
  return npmLock;
}

function buildNpmFiles(version, meta, bundled) {
  const deps = { 'zn-gate': version };
  for (const name of bundled.keys()) deps[name] = bundled.get(name);
  const sortedDeps = Object.fromEntries(Object.keys(deps).sort().map((k) => [k, deps[k]]));
  const pkg = {
    name: NPM_NAME,
    version,
    private: true,
    description: 'The zn-gate release this plugin runs. Claude Code installs it into the plugin folder; the launcher checks it against scripts/zn-gate.lock.json.',
    license: 'MIT',
    dependencies: sortedDeps,
  };
  // npm resolves the lock in a scratch directory, from this package.json only.
  const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zn-pin-'));
  let npmLock;
  try {
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    // npm's own CLI script, run with this node (no shell, no npm.cmd): next to
    // node on Windows, under <prefix>/lib on Linux and macOS; else npm from PATH.
    const prefix = path.dirname(process.execPath);
    const npmCli = [path.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(prefix, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((f) => fs.existsSync(f));
    const args = ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', REGISTRY];
    const r = npmCli
      ? spawnSync(process.execPath, [npmCli, ...args], { cwd: work, encoding: 'utf8', windowsHide: true })
      : spawnSync('npm', args, { cwd: work, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error('npm install --package-lock-only failed: ' + String(r.stderr || r.error || '').trim().slice(0, 500));
    npmLock = stripBundled(JSON.parse(fs.readFileSync(path.join(work, 'package-lock.json'), 'utf8')));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const z = npmLock.packages['node_modules/zn-gate'];
  if (!z || z.version !== version || z.integrity !== meta.dist.integrity) throw new Error('the npm lock does not pin the checked zn-gate tarball');
  for (const [k, e] of Object.entries(npmLock.packages)) {
    if (k && (!/^sha512-/.test(e.integrity || '') || !String(e.resolved || '').startsWith(REGISTRY + '/'))) {
      throw new Error('the npm lock entry ' + k + ' has no sha512 integrity or registry URL');
    }
    if (e.hasInstallScript) throw new Error('the npm lock entry ' + k + ' has an install script');
  }
  return { pkg, npmLock };
}

module.exports = { buildNpmFiles, stripBundled, get, tarEntries, versionedTexts };

if (require.main === module) main(process.argv.slice(2)).catch((err) => {
  process.stderr.write('pin-release: ' + err.message + '\n');
  process.exitCode = 1;
});
