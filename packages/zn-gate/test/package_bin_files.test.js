'use strict';
/*
 * Package folder check: every path named in "bin" and "files" of package.json
 * exists, each bin file starts with a node shebang line, and no "files" entry
 * points outside the package. The check is run on the real package and on
 * temporary folders that break each rule.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHEBANG = /^#!\/usr\/bin\/env node\r?$/;

function binPaths(pkg) {
  if (typeof pkg.bin === 'string') return [pkg.bin];
  return Object.values(pkg.bin || {});
}

function escapes(root, entry) {
  if (path.isAbsolute(entry) || /^[A-Za-z]:/.test(entry)) return true;
  const rel = path.relative(root, path.resolve(root, entry));
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}

function check(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const problems = [];
  for (const f of pkg.files || []) {
    if (escapes(root, f)) problems.push('outside: ' + f);
    else if (!fs.existsSync(path.join(root, f))) problems.push('missing: ' + f);
  }
  for (const b of binPaths(pkg)) {
    if (escapes(root, b)) { problems.push('outside: ' + b); continue; }
    const p = path.join(root, b);
    if (!fs.existsSync(p)) { problems.push('missing: ' + b); continue; }
    const first = fs.readFileSync(p, 'utf8').split('\n')[0];
    if (!SHEBANG.test(first)) problems.push('no shebang: ' + b);
  }
  return problems;
}

function tmpPackage(pkg, filesOnDisk) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-pkg-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  for (const [name, body] of Object.entries(filesOnDisk)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

function withPackage(pkg, filesOnDisk, fn) {
  const root = tmpPackage(pkg, filesOnDisk);
  try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('the real package has all bin and files entries, shebangs, and nothing outside', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(binPaths(pkg).length > 0);
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0);
  assert.deepEqual(check(root), []);
});

test('a good temporary package passes', () => {
  withPackage({ bin: { tool: 'bin/t.js' }, files: ['bin/', 'README.md'] },
    { 'bin/t.js': '#!/usr/bin/env node\n', 'README.md': 'x' },
    (root) => assert.deepEqual(check(root), []));
});

test('a missing bin file and a missing files entry are reported', () => {
  withPackage({ bin: { tool: 'bin/t.js' }, files: ['lib/'] }, {},
    (root) => assert.deepEqual(check(root), ['missing: lib/', 'missing: bin/t.js']));
});

test('a bin file without a node shebang is reported', () => {
  withPackage({ bin: { a: 'a.js', b: 'b.js', c: 'c.js' } },
    { 'a.js': 'console.log(1)\n', 'b.js': '#!/bin/sh\n', 'c.js': '\n#!/usr/bin/env node\n' },
    (root) => assert.deepEqual(check(root), ['no shebang: a.js', 'no shebang: b.js', 'no shebang: c.js']));
});

test('files entries that point outside the package are reported', () => {
  withPackage({ files: ['../other/', 'lib/../../x.js', '/etc/example', 'ok.txt', 'a/../ok.txt'] },
    { 'ok.txt': 'x' },
    (root) => assert.deepEqual(check(root), ['outside: ../other/', 'outside: lib/../../x.js', 'outside: /etc/example']));
});

test('bin may be a single string', () => {
  withPackage({ bin: 'cli.js' }, { 'cli.js': '#!/usr/bin/env node\n' },
    (root) => assert.deepEqual(check(root), []));
});
