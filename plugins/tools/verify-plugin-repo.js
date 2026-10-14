#!/usr/bin/env node
'use strict';

/**
 * Check a checkout of the Claude Code plugin repository (usezn/zn-gate-plugin)
 * against this repository and the published zn-gate tarball. The plugin
 * repository's CI runs it from this repository at the release tag, on every
 * pull request into its main branch.
 *
 *   node plugins/tools/verify-plugin-repo.js --repo <plugin checkout> --tarball <zn-gate-X.Y.Z.tgz>
 *
 * The checks do not reuse the build: each one compares the checkout with a
 * source directly (PROVENANCE.md in the plugin repository lists them).
 *  1. The tarball's sha512 matches the npm registry and the lock file.
 *  2. vendor/zn-gate holds exactly the tarball's files minus TypeScript
 *     sources, declarations and source maps, byte for byte.
 *  3. scripts/zn-gate.lock.json lists exactly those files with their SHA-256,
 *     "bundled": "vendor/zn-gate", and the tarball's version and integrity.
 *  4. Every other file is byte for byte the file it comes from in this
 *     repository (plugins/zn-gate or plugins/claude-dir), except
 *     .gitattributes, which is "* -text", and .github/workflows/verify.yml,
 *     which is plugins/claude-dir/verify.yml. Nothing else may be there.
 *  5. The plugin version is the tarball's version, and the directory limits
 *     hold.
 *
 * Network: the npm registry (step 1), unless the tests pass the integrity.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { get, tarEntries } = require('./pin-release');
const builder = require('./build-plugin-repo');

const ROOT = path.resolve(__dirname, '..', '..');
const PRUNE = /\.(?:d\.[mc]?ts|[mc]?ts|map)$/;
const EXTRA_FILES = {
  '.gitattributes': Buffer.from('* -text\n'),
  '.github/workflows/verify.yml': null, // compared with plugins/claude-dir/verify.yml
};

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Every file in the checkout (not .git), as relative POSIX paths; links are problems. */
function listFiles(dir, problems) {
  const out = new Map();
  const walk = (rel) => {
    const abs = rel ? path.join(dir, ...rel.split('/')) : dir;
    for (const name of fs.readdirSync(abs)) {
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

async function verify({ repo, tarball, integrity }) {
  const problems = [];
  const tgz = fs.readFileSync(tarball);
  const actual = 'sha512-' + crypto.createHash('sha512').update(tgz).digest('base64');

  const pkgFiles = new Map();
  for (const e of tarEntries(zlib.gunzipSync(tgz))) {
    if (!e.name.startsWith('package/')) throw new Error('unexpected path in tarball: ' + e.name);
    pkgFiles.set(e.name.slice('package/'.length), e.body);
  }
  const pkg = JSON.parse(pkgFiles.get('package.json').toString('utf8'));
  const version = pkg.version;

  // 1. Integrity.
  let registry = integrity;
  if (!registry) {
    const meta = JSON.parse((await get('https://registry.npmjs.org/zn-gate/' + version)).toString('utf8'));
    registry = meta.dist && meta.dist.integrity;
  }
  if (actual !== registry) problems.push('the tarball does not match the npm registry integrity for zn-gate ' + version);

  const files = listFiles(path.resolve(repo), problems);

  // 2. vendor/zn-gate is the tarball minus pruned files.
  const vendor = new Map();
  for (const [rel, body] of files) if (rel.startsWith('vendor/zn-gate/')) vendor.set(rel.slice('vendor/zn-gate/'.length), body);
  for (const [rel, body] of pkgFiles) {
    if (PRUNE.test(rel)) {
      if (vendor.has(rel)) problems.push('vendor/zn-gate/' + rel + ' should have been left out');
      continue;
    }
    if (!vendor.has(rel)) problems.push('vendor/zn-gate/' + rel + ' is missing');
    else if (!vendor.get(rel).equals(body)) problems.push('vendor/zn-gate/' + rel + ' differs from the npm package');
  }
  for (const rel of vendor.keys()) if (!pkgFiles.has(rel)) problems.push('vendor/zn-gate/' + rel + ' is not in the npm package');
  for (const rel of files.keys()) if (rel.startsWith('vendor/') && !rel.startsWith('vendor/zn-gate/')) problems.push(rel + ' is not expected');

  // 3. The lock file.
  let lock = null;
  try {
    lock = JSON.parse((files.get('scripts/zn-gate.lock.json') || Buffer.from('')).toString('utf8'));
  } catch (_) {
    problems.push('scripts/zn-gate.lock.json is not valid JSON');
  }
  if (lock) {
    if (lock.package !== 'zn-gate' || lock.version !== version || lock.integrity !== actual || lock.bundled !== 'vendor/zn-gate') {
      problems.push('scripts/zn-gate.lock.json does not name zn-gate ' + version + ' bundled in vendor/zn-gate with the tarball integrity');
    }
    const listed = lock.files && typeof lock.files === 'object' ? lock.files : {};
    for (const [rel, body] of vendor) if (listed[rel] !== sha256(body)) problems.push('the lock file digest of ' + rel + ' is wrong or missing');
    for (const rel of Object.keys(listed)) if (!vendor.has(rel)) problems.push('the lock file lists ' + rel + ', which is not in vendor/zn-gate');
  }

  // 4. Every other file comes from this repository, unchanged.
  const expected = new Map();
  for (const [rel, from] of builder.PLUGIN_FILES) expected.set(rel, fs.readFileSync(path.join(from, ...rel.split('/'))));
  for (const [rel, body] of Object.entries(EXTRA_FILES)) {
    expected.set(rel, body || fs.readFileSync(path.join(ROOT, 'plugins', 'claude-dir', 'verify.yml')));
  }
  for (const [rel, body] of expected) {
    if (!files.has(rel)) {
      if (rel !== '.github/workflows/verify.yml') problems.push(rel + ' is missing');
    } else if (!files.get(rel).equals(body)) {
      problems.push(rel + ' differs from usezn/zn');
    }
  }
  for (const rel of files.keys()) {
    if (rel.startsWith('vendor/zn-gate/') || rel === 'scripts/zn-gate.lock.json' || expected.has(rel)) continue;
    problems.push(rel + ' is not expected');
  }

  // 5. Version and limits.
  const manifest = JSON.parse((files.get('.claude-plugin/plugin.json') || Buffer.from('{}')).toString('utf8'));
  if (manifest.version !== version) problems.push('.claude-plugin/plugin.json has version ' + manifest.version + ', the package is ' + version);
  const shipped = new Map([...files].filter(([rel]) => !rel.startsWith('.github/')));
  problems.push(...builder.checkLimits(shipped));

  return { version, files: files.size, problems };
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

module.exports = { verify };

if (require.main === module) {
  verify(parseArgs(process.argv.slice(2))).then((r) => {
    if (r.problems.length) {
      process.stderr.write('verify-plugin-repo: ' + r.problems.length + ' problem(s) with zn-gate ' + r.version + ':\n  ' + r.problems.join('\n  ') + '\n');
      process.exitCode = 1;
    } else {
      process.stdout.write('verify-plugin-repo: OK, zn-gate ' + r.version + ', ' + r.files + ' files\n');
    }
  }).catch((err) => {
    process.stderr.write('verify-plugin-repo: ' + err.message + '\n');
    process.exitCode = 1;
  });
}
