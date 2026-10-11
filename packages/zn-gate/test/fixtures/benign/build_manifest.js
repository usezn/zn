'use strict';
/*
 * Regenerates or verifies MANIFEST.json for the benign corpus.
 *
 *   node build_manifest.js            regenerate the manifest from the files
 *   node build_manifest.js --verify   fail unless every file matches the manifest
 *
 * MANIFEST.json pins one sha256 per file, so fetch_corpus.sh guarantees the
 * exact same bytes on every machine and CI run. Regeneration is a maintainer
 * action: only run it together with a source pin change in fetch_corpus.sh.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEST = __dirname;
const MANIFEST_PATH = path.join(DEST, 'MANIFEST.json');
const PY_TAG = process.env.PY_TAG || 'v3.14.8';

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function addSource(manifest, dir, source) {
  const files = walk(dir);
  for (const f of files) {
    manifest.files[path.relative(DEST, f).replace(/\\/g, '/')] = [source.id, sha256(f)];
  }
  source.files = files.length;
  manifest.sources.push(source);
}

function generate() {
  const pyDir = path.join(DEST, 'python-stdlib');
  const npmDir = path.join(DEST, 'npm');
  const licDir = path.join(DEST, 'licenses');
  if (!fs.existsSync(pyDir) || !fs.existsSync(npmDir)) {
    console.error('no corpus found under ' + DEST);
    console.error('run fetch_corpus.sh first, then re-run this script to regenerate the manifest');
    process.exit(1);
  }

  const manifest = {
    description: 'Benign corpus for bench/leak_bench.js: real permissively licensed code used to measure over-redaction. Downloaded and verified with fetch_corpus.sh; the files themselves are not committed.',
    files: {},
    sources: [],
  };

  addSource(manifest, pyDir, {
    id: 'python-stdlib',
    origin: 'CPython ' + PY_TAG + ' source tag, Lib/**/*.py excluding Lib/test',
    license: 'PSF-2.0',
    url: 'https://github.com/python/cpython/archive/refs/tags/' + PY_TAG + '.tar.gz',
  });

  for (const name of fs.readdirSync(npmDir).sort()) {
    const pkgDir = path.join(npmDir, name);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    addSource(manifest, pkgDir, {
      id: 'npm:' + pkg.name + '@' + pkg.version,
      origin: 'npm registry tarball',
      license: pkg.license || 'unknown',
      url: 'https://registry.npmjs.org/' + pkg.name + '/-/' + pkg.name + '-' + pkg.version + '.tgz',
    });
  }

  if (fs.existsSync(licDir)) {
    addSource(manifest, licDir, {
      id: 'licenses',
      origin: 'license texts kept alongside the corpus',
      license: 'see each file',
      url: null,
    });
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log('MANIFEST.json regenerated: ' + Object.keys(manifest.files).length + ' files, ' + manifest.sources.length + ' sources');
}

function verify() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('MANIFEST.json not found at ' + MANIFEST_PATH);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const problems = [];
  let ok = 0;
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const expected = Array.isArray(entry) ? entry[1] : entry && entry.sha256;
    const abs = path.join(DEST, rel);
    if (!fs.existsSync(abs)) {
      problems.push('missing: ' + rel);
      continue;
    }
    if (sha256(abs) !== expected) {
      problems.push('checksum mismatch: ' + rel);
      continue;
    }
    ok++;
  }
  if (problems.length > 0) {
    console.error('corpus verification FAILED: ' + problems.length + ' problem(s), ' + ok + ' ok');
    for (const p of problems.slice(0, 20)) console.error('  - ' + p);
    if (problems.length > 20) console.error('  ... and ' + (problems.length - 20) + ' more');
    console.error('run: bash fetch_corpus.sh   (re-downloads the pinned sources)');
    process.exit(1);
  }
  console.log('corpus verified: ' + ok + ' files match MANIFEST.json sha256');
}

if (require.main === module) {
  if (process.argv.includes('--verify')) verify();
  else generate();
}
