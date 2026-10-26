#!/usr/bin/env node
'use strict';

/**
 * Check a checkout of the Claude Code plugin repository (usezn/zn-gate-plugin)
 * or of the ZCode plugin repository against this repository and the published
 * zn-gate tarball. The plugin repository's Verify workflow runs it from this
 * repository at the commit the plugin was generated from (the "source" in its
 * lock file), on every pull request into its main branch and on main itself.
 *
 *   node plugins/tools/verify-plugin-repo.js --repo <plugin checkout> --tarball <zn-gate-X.Y.Z.tgz> [--target claude|zcode]
 *
 * The target is the one the repository was built with (build-plugin-repo.js
 * --target): claude by default. The ZCode tree keeps the plugin in zn-gate/
 * (so vendor/, the lock and the manifest are under that folder) and has its own
 * marketplace.json at the root; the same checks apply to it, with the files of
 * plugins/zcode in place of the Claude Code ones, plus: the manifest names
 * zn-gate, every hook runs scripts/zn-hook.sh with its own event name, the
 * script is a shell script, and the marketplace lists exactly that plugin.
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

const ZCODE_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse'];

function readJson(files, rel, problems) {
  if (!files.has(rel)) return null; // reported as missing by the file comparison
  try {
    return JSON.parse(files.get(rel).toString('utf8'));
  } catch (_) {
    problems.push(rel + ' is not valid JSON');
    return null;
  }
}

/**
 * What only the ZCode plugin has to be: the checks of its own files that the byte-for-byte comparison with
 * plugins/zcode does not give by itself, so that a tree that is the same as a wrong source still fails.
 */
function zcodeProblems(files, dir) {
  const problems = [];
  const manifest = readJson(files, dir + '.zcode-plugin/plugin.json', problems);
  if (manifest && manifest.name !== 'zn-gate') problems.push(dir + '.zcode-plugin/plugin.json names the plugin ' + JSON.stringify(manifest.name) + ', not zn-gate');

  const hooks = readJson(files, dir + 'hooks/hooks.json', problems);
  if (hooks) {
    const events = Object.keys(hooks.hooks || {});
    for (const event of ZCODE_EVENTS) if (!events.includes(event)) problems.push(dir + 'hooks/hooks.json has no ' + event + ' hook');
    for (const event of events) {
      if (!ZCODE_EVENTS.includes(event)) problems.push(dir + 'hooks/hooks.json has a hook for ' + event + ', which the plugin does not use');
      for (const group of hooks.hooks[event] || []) {
        for (const h of (group && group.hooks) || []) {
          const ok = h && h.type === 'process' && h.command === '/bin/sh' && Array.isArray(h.args) && h.args.length === 2 &&
            h.args[0] === '${ZCODE_PLUGIN_ROOT}/scripts/zn-hook.sh' && h.args[1] === event;
          if (!ok) problems.push(dir + 'hooks/hooks.json: a ' + event + ' hook does not run `/bin/sh ${ZCODE_PLUGIN_ROOT}/scripts/zn-hook.sh ' + event + '`');
        }
      }
    }
  }

  // The hook is started as `sh <script>`, so it needs no executable bit (the plugin repository's Verify workflow
  // accepts only mode 100644); it has to be a POSIX shell script.
  const script = files.get(dir + 'scripts/zn-hook.sh');
  if (script && !/^#!\/bin\/sh\n/.test(script.toString('utf8'))) problems.push(dir + 'scripts/zn-hook.sh is not a /bin/sh script');

  const market = readJson(files, 'marketplace.json', problems);
  if (market) {
    const list = Array.isArray(market.plugins) ? market.plugins : [];
    if (list.length !== 1) problems.push('marketplace.json lists ' + list.length + ' plugins, not one');
    else {
      const entry = list[0];
      if (!manifest || entry.name !== manifest.name) problems.push('marketplace.json lists ' + JSON.stringify(entry.name) + ', the plugin manifest says ' + JSON.stringify(manifest && manifest.name));
      if (entry.source !== './' + dir.slice(0, -1)) problems.push('marketplace.json source is ' + JSON.stringify(entry.source) + ', the plugin is in ./' + dir.slice(0, -1));
    }
  }
  return problems;
}

/**
 * opts.integrity replaces the registry lookup and opts.source the commit of
 * this repository; only the tests use them.
 */
async function verify({ repo, tarball, integrity, source, target }) {
  if (target !== undefined && target !== 'claude' && target !== 'zcode') throw new Error('unknown target ' + target + ' (claude or zcode)');
  const zcode = target === 'zcode';
  // Where the files are in each kind of repository.
  const dir = zcode ? builder.ZCODE_DIR + '/' : '';
  const VENDOR = dir + builder.BUNDLED_DIR + '/';
  const LOCK = dir + 'scripts/zn-gate.lock.json';
  const MANIFEST = dir + (zcode ? '.zcode-plugin/plugin.json' : '.claude-plugin/plugin.json');
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
  for (const [rel, body] of files) if (rel.startsWith(VENDOR)) vendor.set(rel.slice(VENDOR.length), body);
  const shippedPkg = [...pkgFiles.keys()].filter((rel) => !PRUNE.test(rel)).sort();
  for (const rel of pkgFiles.keys()) {
    if (PRUNE.test(rel)) {
      if (vendor.has(rel)) problems.push(VENDOR + rel + ' should have been left out');
    } else if (!vendor.has(rel)) {
      problems.push(VENDOR + rel + ' is missing');
    } else if (!vendor.get(rel).equals(pkgFiles.get(rel))) {
      problems.push(VENDOR + rel + ' differs from the npm package');
    }
  }
  for (const rel of vendor.keys()) if (!pkgFiles.has(rel)) problems.push(VENDOR + rel + ' is not in the npm package');

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
  if (!files.has(LOCK)) problems.push(LOCK + ' is missing');
  else if (!files.get(LOCK).equals(lockBytes)) {
    problems.push(LOCK + ' is not the lock of zn-gate ' + version + ' generated from usezn/zn at ' + commit);
  }

  // 4. Every other file comes from this repository, unchanged.
  const expected = new Map();
  if (zcode) {
    for (const [rel, from, dest] of builder.ZCODE_FILES) expected.set(dest, builder.readSource(path.join(from, ...rel.split('/'))));
  } else {
    for (const [rel, from] of builder.PLUGIN_FILES) expected.set(rel, fs.readFileSync(path.join(from, ...rel.split('/'))));
  }
  expected.set('.gitattributes', Buffer.from('* -text\n'));
  for (const [rel, body] of expected) {
    if (!files.has(rel)) problems.push(rel + ' is missing');
    else if (!files.get(rel).equals(body)) problems.push(rel + ' differs from usezn/zn at ' + commit);
  }
  if (!files.has(WORKFLOW)) problems.push(WORKFLOW + ' is missing');
  for (const rel of files.keys()) {
    if (rel.startsWith(VENDOR) || rel === LOCK || rel === WORKFLOW || expected.has(rel)) continue;
    problems.push(rel + ' is not expected');
  }

  // 5. Version and limits.
  let manifestVersion = null;
  try {
    manifestVersion = JSON.parse(files.get(MANIFEST).toString('utf8')).version;
  } catch (_) { /* reported as missing or different above */ }
  if (manifestVersion !== version) problems.push(MANIFEST + ' has version ' + manifestVersion + ', the package is ' + version);
  if (zcode) problems.push(...zcodeProblems(files, dir));
  const shipped = new Map([...files].filter(([rel]) => !rel.startsWith('.github/')));
  problems.push(...builder.checkLimits(shipped));

  return { version, source: commit, files: files.size, problems };
}

const USAGE = 'usage: verify-plugin-repo.js --repo <dir> --tarball <tgz> [--target claude|zcode]';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--repo', '--tarball', '--target'].includes(argv[i]) || argv[i + 1] === undefined) throw new Error(USAGE);
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  if (!opts.repo || !opts.tarball) throw new Error(USAGE);
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
