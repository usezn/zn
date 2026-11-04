'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fingerprint, whichSync, isInterpreterPath } = require('../lib/exe');

const isWin = process.platform === 'win32';

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-exe-edges-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('fingerprint: missing file, directory and empty input give null', (t) => {
  const d = tmp(t);
  assert.equal(fingerprint(path.join(d, 'absent')), null);
  assert.equal(fingerprint(d), null);
  assert.equal(fingerprint(''), null);
  assert.equal(fingerprint(undefined), null);
  assert.equal(fingerprint(null), null);
  assert.equal(fingerprint(42.5), null);
});

test('fingerprint: an empty file has four fields and size 0', (t) => {
  const d = tmp(t);
  const f = path.join(d, 'empty');
  fs.writeFileSync(f, '');
  const parts = fingerprint(f).split(':');
  assert.equal(parts.length, 4);
  assert.equal(parts[2], '0');
});

test('fingerprint: stable when unchanged, different after a rewrite with a new size', (t) => {
  const d = tmp(t);
  const f = path.join(d, 'prog');
  fs.writeFileSync(f, 'a');
  const first = fingerprint(f);
  assert.equal(fingerprint(f), first);
  fs.writeFileSync(f, 'abc');
  assert.notEqual(fingerprint(f), first);
});

test('fingerprint: a symlink to a file gives the fingerprint of its target', (t) => {
  if (isWin) return t.skip('symlinks need privileges on Windows');
  const d = tmp(t);
  const f = path.join(d, 'prog');
  fs.writeFileSync(f, 'x');
  const l = path.join(d, 'link');
  fs.symlinkSync(f, l);
  assert.equal(fingerprint(l), fingerprint(f));
});

test('fingerprint: a dangling symlink gives null', (t) => {
  if (isWin) return t.skip('symlinks need privileges on Windows');
  const d = tmp(t);
  const l = path.join(d, 'link');
  fs.symlinkSync(path.join(d, 'gone'), l);
  assert.equal(fingerprint(l), null);
});

test('whichSync: empty, undefined and empty PATH give null', () => {
  assert.equal(whichSync('', '/usr/bin'), null);
  assert.equal(whichSync('prog-that-does-not-exist', ''), null);
  assert.equal(whichSync('prog-that-does-not-exist', undefined), null);
});

test('whichSync: finds a file in a PATH directory and the first match wins', (t) => {
  const d1 = tmp(t);
  const d2 = tmp(t);
  const name = isWin ? 'zn-edge-tool.exe' : 'zn-edge-tool';
  fs.writeFileSync(path.join(d1, name), '');
  fs.writeFileSync(path.join(d2, name), '');
  const found = whichSync(name, [d1, d2].join(path.delimiter));
  assert.equal(found, path.join(d1, name));
  assert.equal(whichSync(name, [d2, d1].join(path.delimiter)), path.join(d2, name));
});

test('whichSync: empty PATH entries are skipped', (t) => {
  const d = tmp(t);
  const name = isWin ? 'zn-edge-tool.exe' : 'zn-edge-tool';
  fs.writeFileSync(path.join(d, name), '');
  assert.equal(whichSync(name, [path.delimiter, '', d].join(path.delimiter)), path.join(d, name));
});

test('whichSync: a directory with the program name is not a match', (t) => {
  const d = tmp(t);
  fs.mkdirSync(path.join(d, 'zn-edge-dir'));
  assert.equal(whichSync('zn-edge-dir', d), null);
});

test('whichSync: does not check the executable bit', (t) => {
  if (isWin) return t.skip('no executable bit on Windows');
  const d = tmp(t);
  const f = path.join(d, 'zn-edge-plain');
  fs.writeFileSync(f, '');
  fs.chmodSync(f, 0o600);
  assert.equal(whichSync('zn-edge-plain', d), f);
});

test('whichSync: a name with a separator is resolved without PATH', (t) => {
  const d = tmp(t);
  const f = path.join(d, 'prog');
  fs.writeFileSync(f, '');
  assert.equal(whichSync(f, ''), path.resolve(f));
  assert.equal(whichSync(path.join(d, 'nope'), d), null);
});

test('isInterpreterPath: empty and non-string input is not an interpreter', () => {
  for (const v of ['', undefined, null, 0, {}, '/', '/usr/bin/']) assert.equal(isInterpreterPath(v), false);
});

test('isInterpreterPath: version suffixes, extensions and case are ignored', () => {
  for (const p of ['/usr/bin/python3.12', '/usr/bin/python3.12m', '/usr/bin/node22', '/opt/PYTHON3', 'C:\\Python\\pythonw.exe', '/bin/bash', 'C:\\x\\PWSH.EXE', '/usr/bin/python3-beta']) {
    assert.equal(isInterpreterPath(p), true, p);
  }
});

test('isInterpreterPath: only the file name counts, not the directories', () => {
  assert.equal(isInterpreterPath('/usr/lib/python3/bin/mytool'), false);
  assert.equal(isInterpreterPath('/opt/node/bin/'), false);
  assert.equal(isInterpreterPath('/usr/bin/pythonista'), false);
  assert.equal(isInterpreterPath('/usr/bin/nodemon'), false);
});

test('isInterpreterPath: a path with spaces is not split into words', () => {
  assert.equal(isInterpreterPath('/opt/my tools/python3.11'), true);
  assert.equal(isInterpreterPath('/opt/python3 tools/mytool'), false);
});

test('isInterpreterPath: a very long name is answered quickly and is not an interpreter', () => {
  const start = Date.now();
  assert.equal(isInterpreterPath('/x/' + 'a1-'.repeat(5000)), false);
  assert.ok(Date.now() - start < 1000);
});
