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
