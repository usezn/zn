#!/usr/bin/env node
'use strict';

/**
 * Build the tree of the Claude Code plugin repository (usezn/zn-gate-plugin)
 * from this monorepo and a published zn-gate tarball.
 *
 *   node plugins/tools/build-plugin-repo.js --tarball <zn-gate-X.Y.Z.tgz> --out <dir> [--source <commit>]
 *
 * The plugin repository is never edited by hand: the release workflow runs
 * this script and opens a pull request with its output, which is checked
 * again, independently, before it is merged: every bundled file against the
 * npm tarball, the tarball's provenance attestation, and every other file
 * against this repository at the release tag.
 *
 * These checks catch a build that ships the wrong files and code that would
 * load modules from outside the plugin. They are not a defence against a
 * malicious zn-gate release: code in the package can use Node's built-in
 * modules directly.
 *
 * 1. The tarball must match the sha512 integrity that the npm registry lists
 *    for zn-gate@X.Y.Z, and the release the plugin is pinned to
 *    (plugins/zn-gate/scripts/zn-gate.lock.json).
 * 2. zn-gate is written to vendor/zn-gate without TypeScript sources, type
 *    declarations and source maps, so the plugin stays well under the
 *    directory's file limit. Every bundled file is the exact bytes from the
 *    tarball.
 * 3. ES modules are resolved by Node from disk, outside the launcher's
 *    verified loader (require() calls are resolved by the launcher, only to
 *    verified files). So every static import of every ES module, read with
 *    Node's own parser, and every import() in any bundled file must name a
 *    module inside the bundle or a Node.js built-in. A name that is not
 *    bundled would be looked up in parent node_modules folders the plugin
 *    does not control. Code that reaches Node's module system another way
 *    cannot be checked and is refused: import() with a computed name,
 *    createRequire, import.meta.resolve, process.mainModule, and the
 *    "module" built-in.
 * 4. The plugin files are copied unchanged: the shared ones from
 *    plugins/zn-gate, the README, SECURITY and PROVENANCE files of the plugin
 *    repository from plugins/claude-dir. scripts/zn-gate.lock.json lists the
 *    bundled files with their SHA-256 and "bundled": "vendor/zn-gate", so the
 *    launcher uses only them, and "source", the commit of this repository it
 *    was built from (the current commit unless --source names it), which the
 *    plugin repository's checks compare against.
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
const { spawnSync, execFileSync } = require('child_process');
const { builtinModules } = require('module');
const { get, tarEntries } = require('./pin-release');

const REGISTRY = 'https://registry.npmjs.org';
const PLUGIN = path.resolve(__dirname, '..', 'zn-gate');
const CLAUDE_DIR = path.resolve(__dirname, '..', 'claude-dir');
const BUNDLED_DIR = 'vendor/zn-gate';
// Copied byte for byte. Nothing else of the monorepo plugin (Cursor, Codex
// and Agent Plugins manifests, npm files, its README) is shipped.
const PLUGIN_FILES = [
  ['.claude-plugin/plugin.json', PLUGIN],
  ['.mcp.json', PLUGIN],
  ['hooks/hooks.json', PLUGIN],
  ['icon.png', PLUGIN],
  ['LICENSE', PLUGIN],
  ['scripts/zn-launch.js', PLUGIN],
  ['skills/zn-secrets/SKILL.md', PLUGIN],
  ['README.md', CLAUDE_DIR],
  ['SECURITY.md', CLAUDE_DIR],
  ['PROVENANCE.md', CLAUDE_DIR],
];
const GITATTRIBUTES = '* -text\n';
const PRUNE = /\.(?:d\.[mc]?ts|[mc]?ts|map)$/;
const MAX_FILES = 512;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE = /\.(?:png|jpe?g|gif|webp)$/i;
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, 'node:' + m]));

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Refuse names that could leave the output folder or collide on Windows and macOS. */
function checkName(rel, seen) {
  if (!rel || /[\\:\0-\x1f]/.test(rel) || rel.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error('unexpected path in tarball: ' + JSON.stringify(rel));
  }
  const key = rel.normalize('NFC').toLowerCase();
  if (seen.has(key)) throw new Error('duplicate path in tarball: ' + rel);
  seen.add(key);
}

/** The bundled files: tarball paths without "package/", TypeScript sources, declarations and source maps removed. */
function bundleFiles(tgz) {
  const files = new Map();
  const seen = new Set();
  for (const e of tarEntries(zlib.gunzipSync(tgz))) {
    if (!e.name.startsWith('package/')) throw new Error('unexpected path in tarball: ' + JSON.stringify(e.name));
    const rel = e.name.slice('package/'.length);
    checkName(rel, seen);
    if (PRUNE.test(rel)) continue;
    files.set(rel, e.body);
  }
  for (const need of ['package.json', 'lib/hooks/runner.js', 'lib/broker/mcp.js', 'lib/mcp.js']) {
    if (!files.has(need)) throw new Error('the tarball lacks ' + need + ', which the launcher loads');
  }
  return files;
}

/* ------------------------- import resolution ------------------------- */

function pkgJson(files, dir) {
  const buf = files.get((dir ? dir + '/' : '') + 'package.json');
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return null;
  }
}

/** True when Node loads the bundled file as an ES module. */
function isEsm(files, rel) {
  if (rel.endsWith('.mjs')) return true;
  if (!rel.endsWith('.js')) return false;
  let dir = path.posix.dirname(rel);
  for (;;) {
    const pkg = pkgJson(files, dir === '.' ? '' : dir);
    if (pkg) return pkg.type === 'module';
    if (dir === '.') return false;
    dir = path.posix.dirname(dir);
  }
}

/**
 * The static import and export-from specifiers of each ES module, read with
 * Node's own parser (vm.SourceTextModule, in a child process). A module that
 * does not parse is reported.
 */
function esmRequests(sources) {
  const code = [
    "const vm = require('vm');",
    "const src = JSON.parse(require('fs').readFileSync(0, 'utf8'));",
    'const out = {};',
    'for (const [rel, text] of Object.entries(src)) {',
    '  try {',
    '    const m = new vm.SourceTextModule(text, { identifier: rel });',
    '    // moduleRequests on newer Node.js; dependencySpecifiers before it.',
    '    out[rel] = m.moduleRequests ? m.moduleRequests.map((r) => r.specifier) : [...m.dependencySpecifiers];',
    '  }',
    "  catch (err) { out[rel] = { error: String(err && err.message) }; }",
    '}',
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n');
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', code], {
    input: JSON.stringify(sources),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error('could not parse the bundled ES modules: ' + (r.stderr || r.error));
  return JSON.parse(r.stdout);
}

// The word import, not as a property (obj.import) or part of a name.
const IMPORT_WORD = /(?<![.\w$])import\b/g;
const LITERAL_ARG = /^\s*(['"])([^'"\n]+)\1\s*\)/;
const UNCHECKABLE = /\bcreateRequire\b|\bimport\.meta\.resolve\b|\bprocess\.mainModule\b|\brequire\s*\(\s*(['"])(?:node:)?module\1/;
const MODULE_BUILTINS = new Set(['module', 'node:module']);

/**
 * True for a method named import ("async import(key, format) { ... }"): it
 * follows "async", "{", "," or ";" (or starts a line), its parameters are
 * plain names, and a "{" follows on the same line. A call to import() takes
 * an expression, and never has a block on the same line.
 */
function isMethodDefinition(text, start, from) {
  const before = text.slice(Math.max(0, start - 64), start);
  if (!/(?:\basync\s+|[{,;]\s*|(?:^|\n)[ \t]*)$/.test(before)) return false;
  return /^[ \t]*[\w$]+(?:[ \t]*,[ \t]*[\w$]+)*[ \t]*\)[ \t]*\{/.test(text.slice(from, from + 200));
}

/**
 * Calls of import(): for each word import followed by "(" (with spaces and
 * comments allowed in between), its position and the position after "(".
 * A plain scan without backtracking (only our own release files are read).
 */
function importCalls(text) {
  const calls = [];
  IMPORT_WORD.lastIndex = 0;
  let m;
  while ((m = IMPORT_WORD.exec(text))) {
    let i = m.index + m[0].length;
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? text.length : end + 2;
      } else if (text.startsWith('//', i)) {
        const end = text.indexOf('\n', i + 2);
        i = end < 0 ? text.length : end + 1;
      } else {
        break;
      }
    }
    if (text[i] === '(') calls.push({ start: m.index, from: i + 1 });
  }
  return calls;
}

/** import() specifiers of a file; problems for calls whose name is not a plain string. */
function dynamicImports(rel, text, problems) {
  const out = [];
  for (const call of importCalls(text)) {
    if (isMethodDefinition(text, call.start, call.from)) continue;
    const lit = LITERAL_ARG.exec(text.slice(call.from));
    if (lit) out.push(lit[2]);
    else problems.push(rel + ': import() with a computed name cannot be checked');
  }
  if (UNCHECKABLE.test(text)) {
    problems.push(rel + ': uses createRequire, import.meta.resolve, process.mainModule or the "module" built-in, which cannot be checked');
  }
  return out;
}

function hasFile(files, rel) {
  return files.has(rel);
}

// Conditions active when Node imports an ES module or runs import().
const IMPORT_CONDITIONS = new Set(['node', 'import', 'module-sync', 'default']);

/**
 * True when a target in "exports" names a bundled file inside the package
 * (null, missing and "../" targets are not). In a condition object, the
 * first key that is an active condition decides, as in Node.
 */
function exportTarget(files, pkgDir, target) {
  if (typeof target === 'string') {
    if (!target.startsWith('./')) return false;
    const rel = path.posix.normalize((pkgDir ? pkgDir + '/' : '') + target.slice(2));
    if (pkgDir && !rel.startsWith(pkgDir + '/')) return false;
    if (!pkgDir && rel.startsWith('..')) return false;
    return hasFile(files, rel);
  }
  if (Array.isArray(target)) return target.some((t) => exportTarget(files, pkgDir, t));
  if (target && typeof target === 'object') {
    const cond = Object.keys(target).find((k) => IMPORT_CONDITIONS.has(k));
    return cond !== undefined && exportTarget(files, pkgDir, target[cond]);
  }
  return false;
}

/** True when the bundled package at pkgDir provides the subpath, the way Node resolves it. */
function packageProvides(files, pkgDir, sub) {
  const pkg = pkgJson(files, pkgDir) || {};
  const key = sub ? './' + sub : '.';
  const exp = pkg.exports;
  if (exp !== undefined && exp !== null) {
    const map = typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith('.')) ? exp : { '.': exp };
    if (key in map) return exportTarget(files, pkgDir, map[key]);
    for (const [k, v] of Object.entries(map)) {
      const star = k.indexOf('*');
      if (star >= 0 && key.startsWith(k.slice(0, star)) && key.endsWith(k.slice(star + 1)) && key.length >= k.length - 1) {
        const middle = key.slice(star, key.length - (k.length - star - 1));
        return exportTarget(files, pkgDir, JSON.parse(JSON.stringify(v).split('*').join(middle)));
      }
    }
    return false;
  }
  const base = pkgDir ? pkgDir + '/' : '';
  if (sub) return [sub, sub + '.js', sub + '.json', sub + '/index.js'].some((c) => hasFile(files, base + c));
  const main = (pkg.main || 'index.js').replace(/^\.\//, '');
  return [main, main + '.js', main + '/index.js'].some((c) => hasFile(files, path.posix.normalize(base + c)));
}

/** Problems with one specifier imported by the bundled file rel. */
function resolveProblem(files, rel, spec) {
  if (MODULE_BUILTINS.has(spec)) return rel + ': imports the "module" built-in, which cannot be checked';
  if (BUILTINS.has(spec)) return null;
  if (spec.startsWith('/') || /^[a-z]+:/i.test(spec)) return rel + ': ' + spec + ' is not a bundled module';
  if (spec.startsWith('.')) {
    // ES modules name the file exactly (no extension search).
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    if (target.startsWith('..') || !hasFile(files, target)) return rel + ': ' + spec + ' is not in the bundle';
    return null;
  }
  const parts = spec.split('/');
  const n = spec.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, n).join('/');
  const sub = parts.slice(n).join('/');
  // Node looks in node_modules of each parent folder; the walk stops at the
  // bundle root, since anything above it is outside the plugin's control.
  let dir = path.posix.dirname(rel);
  for (;;) {
    const cand = (dir === '.' ? '' : dir + '/') + 'node_modules/' + name;
    if (files.has(cand + '/package.json')) {
      return packageProvides(files, cand, sub) ? null : rel + ': ' + spec + ' is not in the bundled ' + name;
    }
    if (dir === '.') break;
    dir = path.posix.dirname(dir);
  }
  // A package can import itself by name only through its own "exports".
  const root = pkgJson(files, '');
  if (root && root.name === name && root.exports !== undefined && packageProvides(files, '', sub)) return null;
  return rel + ': ' + spec + ' would be loaded from outside the bundle';
}

/** Problems with the imports that Node resolves from disk, as strings. */
function checkImports(files) {
  const problems = [];
  const esm = {};
  const requests = new Map();
  for (const [rel, body] of files) {
    if (!/\.(?:[mc]?js)$/.test(rel)) continue;
    const text = body.toString('utf8');
    requests.set(rel, dynamicImports(rel, text, problems));
    if (isEsm(files, rel)) esm[rel] = text;
  }
  if (Object.keys(esm).length) {
    for (const [rel, specs] of Object.entries(esmRequests(esm))) {
      if (!Array.isArray(specs)) problems.push(rel + ': does not parse as an ES module (' + specs.error + ')');
      else requests.get(rel).push(...specs);
    }
  }
  for (const [rel, specs] of requests) {
    for (const spec of new Set(specs)) {
      const p = resolveProblem(files, rel, spec);
      if (p) problems.push(p);
    }
  }
  return problems;
}

/* ------------------------------ build ------------------------------ */

function pluginTree(bundle, version, integrity, source) {
  const out = new Map();
  for (const [rel, from] of PLUGIN_FILES) {
    const abs = path.join(from, ...rel.split('/'));
    if (fs.lstatSync(abs).isSymbolicLink()) throw new Error(path.relative(path.resolve(__dirname, '..', '..'), abs) + ' is a symbolic link');
    out.set(rel, fs.readFileSync(abs));
  }
  const manifest = JSON.parse(out.get('.claude-plugin/plugin.json').toString('utf8'));
  if (manifest.version !== version) {
    throw new Error('plugins/zn-gate is pinned to ' + manifest.version + ', the tarball is zn-gate ' + version + ': run pin-release.js first');
  }
  const files = {};
  for (const rel of [...bundle.keys()].sort()) files[rel] = sha256(bundle.get(rel));
  const lock = { package: 'zn-gate', version, registry: REGISTRY, integrity, bundled: BUNDLED_DIR, source, files };
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

/**
 * Build the tree into out. opts.integrity replaces the registry lookup; only
 * the tests use it (the command line has no such option).
 */
async function build({ tarball, out, integrity, source }) {
  const commit = source || execFileSync('git', ['-C', path.resolve(__dirname, '..', '..'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('the source must be a full commit hash: ' + commit);
  const tgz = fs.readFileSync(tarball);
  const bundle = bundleFiles(tgz);
  const pkg = pkgJson(bundle, '');
  if (!pkg || pkg.name !== 'zn-gate' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version || '')) throw new Error('not a zn-gate release tarball');
  const expected = integrity || await registryIntegrity(pkg.version);
  const actual = 'sha512-' + crypto.createHash('sha512').update(tgz).digest('base64');
  if (actual !== expected) throw new Error('tarball integrity mismatch: expected ' + expected + ', file ' + actual);
  if (!integrity) {
    const pin = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'scripts', 'zn-gate.lock.json'), 'utf8'));
    if (pin.version !== pkg.version || pin.integrity !== actual) {
      throw new Error('the tarball is not the release plugins/zn-gate is pinned to (' + pin.version + ')');
    }
  }

  const importProblems = checkImports(bundle);
  if (importProblems.length) throw new Error('imports that are not checked or do not resolve inside the bundle:\n  ' + importProblems.join('\n  '));
  const tree = pluginTree(bundle, pkg.version, expected, commit);
  const limitProblems = checkLimits(tree);
  if (limitProblems.length) throw new Error('over the plugin directory limits:\n  ' + limitProblems.join('\n  '));

  const root = path.resolve(out);
  // The plugin repository's .git and its own checks (.github) are kept; anything else must be gone.
  if (fs.existsSync(root) && fs.readdirSync(root).some((n) => n !== '.git' && n !== '.github')) throw new Error(out + ' is not empty');
  for (const [rel, body] of tree) {
    const abs = path.resolve(root, ...rel.split('/'));
    if (!abs.startsWith(root + path.sep)) throw new Error('path outside the output folder: ' + rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return { version: pkg.version, files: tree.size, bundled: bundle.size };
}

const USAGE = 'usage: build-plugin-repo.js --tarball <zn-gate-X.Y.Z.tgz> --out <dir> [--source <commit>]';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!['--tarball', '--out', '--source'].includes(k) || v === undefined) throw new Error(USAGE);
    opts[k.slice(2)] = v;
  }
  if (!opts.tarball || !opts.out) throw new Error(USAGE);
  return opts;
}

module.exports = { build, bundleFiles, checkImports, checkLimits, PLUGIN_FILES, BUNDLED_DIR, PRUNE };

if (require.main === module) {
  build(parseArgs(process.argv.slice(2))).then((r) => {
    process.stdout.write('Built the plugin repository for zn-gate ' + r.version + ': ' + r.files + ' files (' + r.bundled + ' bundled)\n');
  }).catch((err) => {
    process.stderr.write('build-plugin-repo: ' + err.message + '\n');
    process.exitCode = 1;
  });
}
