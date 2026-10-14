#!/usr/bin/env node
'use strict';

/**
 * Check a checkout of the Claude Code plugin repository (usezn/zn-gate-plugin)
 * against this repository and the published zn-gate tarball. The plugin
 * repository's Verify workflow runs it from this repository at the commit
 * the plugin was generated from (the "source" in its lock file), on every
 * pull request into its main branch and on main itself.
 *
 *   node plugins/tools/verify-plugin-repo.js --repo <plugin checkout> --tarball <zn-gate-X.Y.Z.tgz>
 *
 * Each check compares the checkout with a source directly; only the plugin
 * file list, the size limits and the tar reader are shared with the build.
 * PROVENANCE.md in the plugin repository lists the checks:
 *  1. The tarball is zn-gate, its sha512 matches the npm registry.
 *  2. vendor/zn-gate holds exactly the tarball's files minus TypeScript
 *     sources, declarations and source maps, byte for byte.
 *  3. scripts/zn-gate.lock.json is exactly the lock for those files: the
 *     version, the integrity, "bundled": "vendor/zn-gate", every SHA-256, and
 *     "source", the commit of this repository the script runs from.
 *  4. Every other file is byte for byte the file it comes from here
 *     (plugins/zn-gate or plugins/claude-dir); .gitattributes is "* -text";
 *     .github/workflows/verify.yml is there (the Verify workflow compares it
 *     with plugins/claude-dir/verify.yml on usezn/zn main, which can be newer
 *     than the source commit). Nothing else may be there, not even an empty
 *     folder.
 *  5. The plugin version is the tarball's version, and the directory limits
 *     hold.
 *
 * Network: the npm registry (step 1), unless the tests pass the integrity.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { get, tarEntries } = require('./pin-release');
const builder = require('./build-plugin-repo');

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY = 'https://registry.npmjs.org';
// Kept separate from the build's copy on purpose; a test checks they agree.
const PRUNE = /\.(?:d\.[mc]?ts|[mc]?ts|map)$/;
const WORKFLOW = '.github/workflows/verify.yml';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Every file in the checkout (not .git); links, other file types and empty folders are problems. */
function listFiles(dir, problems) {
  const out = new Map();
  const walk = (rel) => {
    const abs = rel ? path.join(dir, ...rel.split('/')) : dir;
    const names = fs.readdirSync(abs);
    if (rel && names.length === 0) problems.push(rel + ' is an empty folder');
    for (const name of names) {
      const r = rel ? rel + '/' + name : name;
      if (r === '.git') continue;
      const st = fs.lstatSync(path.join(abs, name));
      if (st.isSymbolicLink()) problems.push(r + ' is a symbolic link');
      else if (st.isDirectory()) walk(r);
      else if (st.isFile()) out.set(r, fs.readFileSync(path.join(abs, name)));
      else problems.push(r + ' is not a regular file');
    }
  };
  walk('');
  return out;
}

function sourceCommit() {
  return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

async function registryIntegrity(version) {
  const meta = JSON.parse((await get(REGISTRY + '/zn-gate/' + version)).toString('utf8'));
  if (meta.name !== 'zn-gate' || meta.version !== version) throw new Error('unexpected registry metadata for zn-gate@' + version);
  const integrity = meta.dist && meta.dist.integrity;
  if (!/^sha512-/.test(integrity || '')) throw new Error('the registry has no sha512 integrity for zn-gate@' + version);
  return integrity;
}

/**
 * opts.integrity replaces the registry lookup and opts.source the commit of
 * this repository; only the tests use them.
 */
async function verify({ repo, tarball, integrity, source }) {
  const problems = [];
  const tgz = fs.readFileSync(tarball);
  const actual = 'sha512-' + crypto.createHash('sha512').update(tgz).digest('base64');

  const pkgFiles = new Map();
  const seen = new Set();
  for (const e of tarEntries(zlib.gunzipSync(tgz))) {
    if (!e.name.startsWith('package/')) throw new Error('unexpected path in tarball: ' + JSON.stringify(e.name));
    const rel = e.name.slice('package/'.length);
    const key = rel.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error('duplicate path in tarball: ' + rel);
    seen.add(key);
    pkgFiles.set(rel, e.body);
  }
  const pkg = JSON.parse((pkgFiles.get('package.json') || Buffer.from('{}')).toString('utf8'));
  if (pkg.name !== 'zn-gate' || !/^\d+\.\d+\.\d+$/.test(pkg.version || '')) throw new Error('not a zn-gate release tarball');
  const version = pkg.version;

  // 1. Integrity.
  const registry = integrity || await registryIntegrity(version);
  if (actual !== registry) problems.push('the tarball does not match the npm registry integrity for zn-gate ' + version);

  const files = listFiles(path.resolve(repo), problems);

  // 2. vendor/zn-gate is the tarball minus pruned files.
  const vendor = new Map();
  for (const [rel, body] of files) if (rel.startsWith('vendor/zn-gate/')) vendor.set(rel.slice('vendor/zn-gate/'.length), body);
  const shippedPkg = [...pkgFiles.keys()].filter((rel) => !PRUNE.test(rel)).sort();
  for (const rel of pkgFiles.keys()) {
    if (PRUNE.test(rel)) {
      if (vendor.has(rel)) problems.push('vendor/zn-gate/' + rel + ' should have been left out');
    } else if (!vendor.has(rel)) {
      problems.push('vendor/zn-gate/' + rel + ' is missing');
    } else if (!vendor.get(rel).equals(pkgFiles.get(rel))) {
      problems.push('vendor/zn-gate/' + rel + ' differs from the npm package');
    }
  }
  for (const rel of vendor.keys()) if (!pkgFiles.has(rel)) problems.push('vendor/zn-gate/' + rel + ' is not in the npm package');

  // 3. The lock file, byte for byte.
  const commit = source || sourceCommit();
  const lock = {
    package: 'zn-gate',
    version,
    registry: REGISTRY,
    integrity: actual,
    bundled: 'vendor/zn-gate',
    source: commit,
    files: Object.fromEntries(shippedPkg.map((rel) => [rel, sha256(pkgFiles.get(rel))])),
  };
  const lockBytes = Buffer.from(JSON.stringify(lock, null, 2) + '\n');
  if (!files.has('scripts/zn-gate.lock.json')) problems.push('scripts/zn-gate.lock.json is missing');
  else if (!files.get('scripts/zn-gate.lock.json').equals(lockBytes)) {
    problems.push('scripts/zn-gate.lock.json is not the lock of zn-gate ' + version + ' generated from usezn/zn at ' + commit);
  }

  // 4. Every other file comes from this repository, unchanged.
  const expected = new Map();
  for (const [rel, from] of builder.PLUGIN_FILES) expected.set(rel, fs.readFileSync(path.join(from, ...rel.split('/'))));
  expected.set('.gitattributes', Buffer.from('* -text\n'));
  for (const [rel, body] of expected) {
    if (!files.has(rel)) problems.push(rel + ' is missing');
    else if (!files.get(rel).equals(body)) problems.push(rel + ' differs from usezn/zn at ' + commit);
  }
  if (!files.has(WORKFLOW)) problems.push(WORKFLOW + ' is missing');
  for (const rel of files.keys()) {
    if (rel.startsWith('vendor/zn-gate/') || rel === 'scripts/zn-gate.lock.json' || rel === WORKFLOW || expected.has(rel)) continue;
    problems.push(rel + ' is not expected');
  }

  // 5. Version and limits.
  let manifestVersion = null;
  try {
    manifestVersion = JSON.parse(files.get('.claude-plugin/plugin.json').toString('utf8')).version;
  } catch (_) { /* reported as missing or different above */ }
  if (manifestVersion !== version) problems.push('.claude-plugin/plugin.json has version ' + manifestVersion + ', the package is ' + version);
  const shipped = new Map([...files].filter(([rel]) => !rel.startsWith('.github/')));
  problems.push(...builder.checkLimits(shipped));

  return { version, source: commit, files: files.size, problems };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--repo', '--tarball'].includes(argv[i]) || argv[i + 1] === undefined) throw new Error('usage: verify-plugin-repo.js --repo <dir> --tarball <tgz>');
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  if (!opts.repo || !opts.tarball) throw new Error('usage: verify-plugin-repo.js --repo <dir> --tarball <tgz>');
  return opts;
}

module.exports = { verify, PRUNE };

if (require.main === module) {
  verify(parseArgs(process.argv.slice(2))).then((r) => {
    if (r.problems.length) {
      process.stderr.write('verify-plugin-repo: ' + r.problems.length + ' problem(s) with zn-gate ' + r.version + ':\n  ' + r.problems.join('\n  ') + '\n');
      process.exitCode = 1;
    } else {
      process.stdout.write('verify-plugin-repo: OK, zn-gate ' + r.version + ' from usezn/zn at ' + r.source + ', ' + r.files + ' files\n');
    }
  }).catch((err) => {
    process.stderr.write('verify-plugin-repo: ' + err.message + '\n');
    process.exitCode = 1;
  });
}
