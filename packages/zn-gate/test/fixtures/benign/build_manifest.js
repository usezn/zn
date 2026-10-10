'use strict';
/*
 * Rebuilds MANIFEST.json for the benign corpus (origin + license of every
 * file). Invoked by fetch_corpus.sh. Walks python-stdlib/, npm/<pkg>/ and
 * licenses/, and records one source entry per origin plus a path -> source
 * map for each file.
 */

const fs = require('fs');
const path = require('path');

const DEST = __dirname;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const manifest = {
  description: 'Benign corpus for bench/leak_bench.js: real permissively licensed code used to measure over-redaction. Regenerate with fetch_corpus.sh.',
  generated_from: {
    python_lib: process.env.PY_LIB || null,
    python_version: process.env.PY_VER || null,
  },
  sources: [],
  files: {},
};

function addFiles(dir, sourceId) {
  let count = 0;
  for (const f of walk(dir)) {
    manifest.files[path.relative(DEST, f).replace(/\\/g, '/')] = sourceId;
    count++;
  }
  return count;
}

const pyDir = path.join(DEST, 'python-stdlib');
if (fs.existsSync(pyDir)) {
  const count = addFiles(pyDir, 'python-stdlib');
  manifest.sources.push({
    id: 'python-stdlib',
    origin: 'CPython standard library, *.py without tests (' + (process.env.PY_LIB || 'local install') +
      ', python ' + (process.env.PY_VER || 'unknown') + ')',
    license: 'PSF-2.0',
    url: 'https://github.com/python/cpython',
    files: count,
  });
}

const npmDir = path.join(DEST, 'npm');
if (fs.existsSync(npmDir)) {
  for (const name of fs.readdirSync(npmDir).sort()) {
    const pkgDir = path.join(npmDir, name);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const id = 'npm:' + pkg.name + '@' + pkg.version;
    const count = addFiles(pkgDir, id);
    manifest.sources.push({
      id,
      origin: 'npm registry tarball',
      license: pkg.license || 'unknown',
      url: 'https://registry.npmjs.org/' + pkg.name + '/-/' + pkg.name + '-' + pkg.version + '.tgz',
      files: count,
    });
  }
}

const licDir = path.join(DEST, 'licenses');
if (fs.existsSync(licDir)) {
  const count = addFiles(licDir, 'licenses');
  manifest.sources.push({
    id: 'licenses',
    origin: 'license texts kept alongside the corpus',
    license: 'see each file',
    url: null,
    files: count,
  });
}

fs.writeFileSync(path.join(DEST, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('MANIFEST.json: ' + Object.keys(manifest.files).length + ' files, ' + manifest.sources.length + ' sources');
