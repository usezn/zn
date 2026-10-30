'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/broker/markers');

test('markerFor and findMarkers round trip a vault name', () => {
  const marker = m.markerFor('GITHUB_TOKEN');
  assert.equal(marker, '__ZN_GITHUB_TOKEN__');
  assert.deepEqual(m.findMarkers('token=' + marker + ';'), [
    { marker, name: 'GITHUB_TOKEN', detected: false },
  ]);
});

test('detected markers are flagged and left out of named markers', () => {
  const found = m.findMarkers('a __ZN_AWS_KEY_1__ b __ZN_DB_URL__');
  assert.deepEqual(found.map((x) => [x.name, x.detected]), [['AWS_KEY_1', true], ['DB_URL', false]]);
  assert.deepEqual(m.findNamedMarkers('a __ZN_AWS_KEY_1__ b __ZN_DB_URL__').map((x) => x.name), ['DB_URL']);
});

test('findMarkers deduplicates and keeps order', () => {
  const found = m.findMarkers('__ZN_B__ __ZN_A__ __ZN_B__');
  assert.deepEqual(found.map((x) => x.name), ['B', 'A']);
});

test('malformed markers are not parsed', () => {
  const bad = ['__ZN_A_', '_ZN_A__', '__ZN_A', '__zn_A__', '__ZN_a__'];
  for (const text of bad) {
    assert.deepEqual(m.findMarkers(text), [], 'should not parse: ' + text);
  }
  assert.deepEqual(m.findMarkers('__ZN___'), []);
  assert.deepEqual(m.findMarkers('__ZN_a__'), []);
  assert.deepEqual(m.findMarkers('__ZN_1ABC__'), []);
  assert.deepEqual(m.findMarkers('__ZN_A B__'), []);
  assert.deepEqual(m.findMarkers('__ZN_A-B__'), []);
  assert.deepEqual(m.findMarkers('__ZN__A__'), []);
});

test('findMarkers ignores non-string input and text without a prefix', () => {
  assert.deepEqual(m.findMarkers(null), []);
  assert.deepEqual(m.findMarkers(42), []);
  assert.deepEqual(m.findMarkers('plain text'), []);
});

test('validateSecretName accepts good names and rejects bad ones', () => {
  assert.equal(m.validateSecretName('GITHUB_TOKEN'), null);
  assert.equal(m.validateSecretName('A1'), null);
  for (const bad of ['', 'lower', '1A', 'A__B', '_A', 'A_', 'A-B', 'A B', null, undefined, 5]) {
    assert.equal(typeof m.validateSecretName(bad), 'string', 'should reject ' + String(bad));
  }
  assert.match(m.validateSecretName('KEY_1'), /reserved/);
  assert.match(m.validateSecretName('A'.repeat(65)), /64/);
  assert.equal(m.validateSecretName('A'.repeat(64)), null);
});

test('every valid name survives a create then parse round trip', () => {
  for (const name of ['A', 'TOKEN', 'MY_API_KEY', 'K2_X9']) {
    assert.equal(m.validateSecretName(name), null);
    const [found] = m.findMarkers(m.markerFor(name));
    assert.equal(found.name, name);
  }
});

test('substitute replaces known names and keeps unknown ones', () => {
  const values = new Map([['A', 'fake-value']]);
  assert.equal(m.substitute('x __ZN_A__ y __ZN_B__', values), 'x fake-value y __ZN_B__');
  assert.equal(m.substitute('no markers', values), 'no markers');
  assert.equal(m.substitute(7, values), 7);
});

test('isDetectedName only matches a trailing _<digits>', () => {
  assert.equal(m.isDetectedName('AWS_KEY_12'), true);
  assert.equal(m.isDetectedName('AWS_KEY'), false);
  assert.equal(m.isDetectedName('KEY1'), false);
});

/* Marker text kept in files of a temporary project. */

const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpProject() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-markers-')));
}

test('markers written to a project file are read back and substituted', () => {
  const dir = tmpProject();
  try {
    const file = path.join(dir, '.env.example');
    fs.writeFileSync(file, 'TOKEN=' + m.markerFor('API_TOKEN') + '\nDB=' + m.markerFor('DB_URL') + '\n');
    const text = fs.readFileSync(file, 'utf8');
    assert.deepEqual(m.findMarkers(text).map((x) => x.name), ['API_TOKEN', 'DB_URL']);
    const out = m.substitute(text, new Map([['API_TOKEN', 'fake-token']]));
    assert.equal(out, 'TOKEN=fake-token\nDB=__ZN_DB_URL__\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removing the markers from a file leaves nothing to find', () => {
  const dir = tmpProject();
  try {
    const file = path.join(dir, 'config.txt');
    fs.writeFileSync(file, 'a=__ZN_ONE__ b=__ZN_TWO__');
    const values = new Map([['ONE', '1'], ['TWO', '2']]);
    fs.writeFileSync(file, m.substitute(fs.readFileSync(file, 'utf8'), values));
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, 'a=1 b=2');
    assert.deepEqual(m.findMarkers(after), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged file with broken bytes still yields the intact markers', () => {
  const dir = tmpProject();
  try {
    const file = path.join(dir, 'damaged.bin');
    fs.writeFileSync(file, Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x00]),
      Buffer.from('__ZN_GOOD__'),
      Buffer.from([0xc3, 0x28, 0x00]),
      Buffer.from('__ZN_CUT'),
    ]));
    const text = fs.readFileSync(file, 'utf8');
    assert.deepEqual(m.findMarkers(text).map((x) => x.name), ['GOOD']);
    assert.equal(m.substitute(text, new Map([['GOOD', 'x']])).includes('__ZN_CUT'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty file has no markers and is returned unchanged', () => {
  const dir = tmpProject();
  try {
    const file = path.join(dir, 'empty.txt');
    fs.writeFileSync(file, '');
    const text = fs.readFileSync(file, 'utf8');
    assert.deepEqual(m.findMarkers(text), []);
    assert.equal(m.substitute(text, new Map([['A', 'x']])), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing folder is reported by the file system, not hidden by the module', () => {
  const dir = tmpProject();
  try {
    const missing = path.join(dir, 'no-such-folder', 'file.txt');
    assert.throws(() => fs.readFileSync(missing, 'utf8'), { code: 'ENOENT' });
    // The path helpers still answer for a folder that does not exist.
    assert.equal(m.checkResolvedExecutable(null, dir), 'command not found on PATH');
    assert.match(
      m.checkResolvedExecutable(path.join(dir, 'no-such-folder', 'tool'), dir),
      /temp directory/,
    );
    assert.equal(m.isInside(missing, dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
