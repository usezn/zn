#!/usr/bin/env node
'use strict';

/**
 * Build the tree of the Claude Code plugin repository (usezn/zn-gate-plugin)
 * from this monorepo and a published zn-gate tarball.
 *
 *   node plugins/tools/build-plugin-repo.js --tarball <zn-gate-X.Y.Z.tgz> --out <dir> [--integrity <sha512-...>]
 *
 * The plugin repository is never edited by hand: the release workflow runs
 * this script and opens a pull request with its output.
 *
 * 1. The tarball must match the sha512 integrity that the npm registry lists
 *    for zn-gate@X.Y.Z (--integrity replaces the registry lookup in tests).
 * 2. zn-gate is written to vendor/zn-gate without type declarations and
 *    source maps (never package.json, .js, .cjs, .mjs or .json), so the plugin
 *    stays well under the directory's file limit. Every bundled file is the
 *    exact bytes from the tarball.
 * 3. Every require/import with a literal name in the bundled code must
 *    resolve inside the bundle (or to a Node.js built-in): Node resolves
 *    bundled ES modules from disk, and a name that is not bundled would be
 *    looked up in parent node_modules folders the plugin does not control.
 * 4. The plugin files are copied unchanged from plugins/zn-gate (a fixed
 *    list), and scripts/zn-gate.lock.json lists the bundled files with their
 *    SHA-256 and "bundled": "vendor/zn-gate", so the launcher uses only them.
 * 5. .gitattributes turns off line-ending conversion: Git for Windows would
 *    otherwise rewrite the bundled files on clone and every check would fail.
 * 6. The directory's limits are checked: at most 512 files, no file other
 *    than an image of 256 KiB or more, none of 5 MiB or more, no links.
 *
 * Everything is computed before anything is written. No dependencies.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { builtinModules } = require('module');
const { get, tarEntries } = require('./pin-release');

const REGISTRY = 'https://registry.npmjs.org';
const PLUGIN = path.resolve(__dirname, '..', 'zn-gate');
const BUNDLED_DIR = 'vendor/zn-gate';
// Copied byte for byte from plugins/zn-gate. Nothing else of the monorepo
// plugin (Cursor, Codex and Agent Plugins manifests, npm files) is shipped.
const PLUGIN_FILES = [
  '.claude-plugin/plugin.json',
  '.mcp.json',
  'hooks/hooks.json',
  'icon.png',
  'LICENSE',
  'README.md',
  'scripts/zn-launch.js',
  'skills/zn-secrets/SKILL.md',
];
const GITATTRIBUTES = '* -text\n';
const PRUNE = /\.(?:d\.[mc]?ts|[mc]?ts|map)$/;
const NEVER_PRUNE = /(?:^|\/)package\.json$|\.(?:[mc]?js|json)$/;
const MAX_FILES = 512;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, 'node:' + m]));

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** The bundled files: tarball paths without "package/", type declarations and source maps removed. */
function bundleFiles(tgz) {
  const files = new Map();
  for (const e of tarEntries(zlib.gunzipSync(tgz))) {
    const rel = e.name.replace(/^package\//, '');
    if (!rel || rel.split('/').some((p) => p === '' || p === '.' || p === '..') || path.isAbsolute(rel)) {
      throw new Error('unexpected path in tarball: ' + e.name);
    }
    if (files.has(rel)) throw new Error('duplicate path in tarball: ' + rel);
    if (PRUNE.test(rel) && !NEVER_PRUNE.test(rel)) continue;
    files.set(rel, e.body);
  }
  for (const need of ['package.json', 'lib/hooks/runner.js', 'lib/broker/mcp.js', 'lib/mcp.js']) {
    if (!files.has(need)) throw new Error('the tarball lacks ' + need + ', which the launcher loads');
  }
  return files;
}

/* ------------------------- import resolution ------------------------- */

// Literal module names in require(), import ... from, import() and export ... from.
const SPECIFIER_RES = [
  /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  /^\s*import\s+(?:[\w*{}\s,$]+\s+from\s+)?(['"])([^'"\n]+)\1/gm,
  /^\s*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+(['"])([^'"\n]+)\1/gm,
];

/**
 * The source with comments blanked out (strings and template literals kept),
 * so examples in doc comments are not read as imports. Regular expression
 * literals are not recognised: a quote inside one is read as the start of a
 * string (to the end of the line for ' and "). The end-to-end test of the
 * built plugin, which plants a decoy package outside the bundle, covers what
 * this static check could miss.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function specifiers(source) {
  source = stripComments(source);
  const out = new Set();
  for (const re of SPECIFIER_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) out.add(m[2]);
  }
  return out;
}

function packageName(spec) {
  const parts = spec.split('/');
  const n = spec.startsWith('@') ? 2 : 1;
  return { name: parts.slice(0, n).join('/'), sub: parts.slice(n).join('/') };
}

function fileOrIndex(files, rel) {
  const tries = [rel, rel + '.js', rel + '.cjs', rel + '.mjs', rel + '.json', rel + '/index.js', rel + '/index.cjs', rel + '/index.mjs'];
  return tries.find((t) => files.has(t)) || null;
}

/** True when the package at pkgDir (a bundle path) has the subpath, through "exports" or as a file. */
function hasSubpath(files, pkgDir, sub) {
  const pkg = JSON.parse(files.get(pkgDir + '/package.json').toString('utf8'));
  const key = sub ? './' + sub : '.';
  if (pkg.exports !== undefined) {
    if (typeof pkg.exports === 'string' || Array.isArray(pkg.exports)) return key === '.';
    const keys = Object.keys(pkg.exports);
    if (!keys.some((k) => k.startsWith('.'))) return key === '.'; // conditions only
    return keys.some((k) => k === key || (k.includes('*') && key.startsWith(k.split('*')[0]) && key.endsWith(k.split('*')[1])));
  }
  if (!sub) return !!(fileOrIndex(files, pkgDir + '/' + (pkg.main || 'index.js').replace(/^\.\//, '')) || fileOrIndex(files, pkgDir + '/index'));
  return !!fileOrIndex(files, pkgDir + '/' + sub);
}

/** Problems with the literal imports of every bundled module, as strings. */
function checkImports(files) {
  const problems = [];
  for (const [rel, body] of files) {
    if (!/\.(?:[mc]?js)$/.test(rel)) continue;
    for (const spec of specifiers(body.toString('utf8'))) {
      if (BUILTINS.has(spec)) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        if (spec.startsWith('/')) { problems.push(rel + ': absolute import ' + spec); continue; }
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
        if (target.startsWith('..') || !fileOrIndex(files, target)) problems.push(rel + ': ' + spec + ' is not in the bundle');
        continue;
      }
      const { name, sub } = packageName(spec);
      if (name === 'zn-gate') continue; // the package itself
      // Node looks in node_modules of each parent folder, up to the bundle root.
      let dir = path.posix.dirname(rel);
      let found = null;
      for (;;) {
        const cand = (dir === '.' ? '' : dir + '/') + 'node_modules/' + name;
        if (files.has(cand + '/package.json')) { found = cand; break; }
        if (dir === '.') break;
        dir = path.posix.dirname(dir);
      }
      if (!found) problems.push(rel + ': ' + spec + ' would be loaded from outside the bundle');
      else if (!hasSubpath(files, found, sub)) problems.push(rel + ': ' + spec + ' is not in the bundled ' + name);
    }
  }
  return problems;
}

/* ------------------------------ build ------------------------------ */

function pluginTree(bundle, version, integrity) {
  const out = new Map();
  for (const rel of PLUGIN_FILES) {
    const abs = path.join(PLUGIN, ...rel.split('/'));
    if (fs.lstatSync(abs).isSymbolicLink()) throw new Error('plugins/zn-gate/' + rel + ' is a symbolic link');
    out.set(rel, fs.readFileSync(abs));
  }
  const manifest = JSON.parse(out.get('.claude-plugin/plugin.json').toString('utf8'));
  if (manifest.version !== version) {
    throw new Error('plugins/zn-gate is pinned to ' + manifest.version + ', the tarball is zn-gate ' + version + ': run pin-release.js first');
  }
  const files = {};
  for (const rel of [...bundle.keys()].sort()) files[rel] = sha256(bundle.get(rel));
  const lock = { package: 'zn-gate', version, registry: REGISTRY, integrity, bundled: BUNDLED_DIR, files };
  out.set('scripts/zn-gate.lock.json', Buffer.from(JSON.stringify(lock, null, 2) + '\n'));
  out.set('.gitattributes', Buffer.from(GITATTRIBUTES));
  for (const [rel, body] of bundle) out.set(BUNDLED_DIR + '/' + rel, body);
  return out;
}

function checkLimits(tree) {
  const problems = [];
  if (tree.size > MAX_FILES) problems.push(tree.size + ' files (the limit is ' + MAX_FILES + ')');
  for (const [rel, body] of tree) {
    if (body.length >= MAX_BYTES) problems.push(rel + ' is ' + body.length + ' bytes (5 MiB or more)');
    else if (!IMAGE.test(rel) && body.length >= MAX_TEXT_BYTES) problems.push(rel + ' is ' + body.length + ' bytes (256 KiB or more)');
  }
  return problems;
}

async function registryIntegrity(version) {
  const meta = JSON.parse((await get(REGISTRY + '/zn-gate/' + version)).toString('utf8'));
  if (meta.name !== 'zn-gate' || meta.version !== version) throw new Error('unexpected registry metadata');
  const integrity = meta.dist && meta.dist.integrity;
  if (!/^sha512-/.test(integrity || '')) throw new Error('the registry has no sha512 integrity for zn-gate@' + version);
  return integrity;
}

async function build({ tarball, out, integrity }) {
  const tgz = fs.readFileSync(tarball);
  const bundle = bundleFiles(tgz);
  const pkg = JSON.parse(bundle.get('package.json').toString('utf8'));
  if (pkg.name !== 'zn-gate' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version || '')) throw new Error('not a zn-gate release tarball');
  const expected = integrity || await registryIntegrity(pkg.version);
  const actual = 'sha512-' + crypto.createHash('sha512').update(tgz).digest('base64');
  if (actual !== expected) throw new Error('tarball integrity mismatch: expected ' + expected + ', file ' + actual);

  const importProblems = checkImports(bundle);
  if (importProblems.length) throw new Error('imports that do not resolve inside the bundle:\n  ' + importProblems.join('\n  '));
  const tree = pluginTree(bundle, pkg.version, expected);
  const limitProblems = checkLimits(tree);
  if (limitProblems.length) throw new Error('over the plugin directory limits:\n  ' + limitProblems.join('\n  '));

  if (fs.existsSync(out) && fs.readdirSync(out).some((n) => n !== '.git')) throw new Error(out + ' is not empty');
  for (const [rel, body] of tree) {
    const abs = path.join(out, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return { version: pkg.version, files: tree.size, bundled: bundle.size };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!['--tarball', '--out', '--integrity'].includes(k) || v === undefined) {
      throw new Error('usage: build-plugin-repo.js --tarball <zn-gate-X.Y.Z.tgz> --out <dir> [--integrity <sha512-...>]');
    }
    opts[k.slice(2)] = v;
  }
  if (!opts.tarball || !opts.out) throw new Error('usage: build-plugin-repo.js --tarball <zn-gate-X.Y.Z.tgz> --out <dir> [--integrity <sha512-...>]');
  return opts;
}

module.exports = { build, bundleFiles, checkImports, checkLimits, specifiers, stripComments, PLUGIN_FILES, BUNDLED_DIR };

if (require.main === module) {
  build(parseArgs(process.argv.slice(2))).then((r) => {
    process.stdout.write('Built the plugin repository for zn-gate ' + r.version + ': ' + r.files + ' files (' + r.bundled + ' bundled)\n');
  }).catch((err) => {
    process.stderr.write('build-plugin-repo: ' + err.message + '\n');
    process.exitCode = 1;
  });
}
