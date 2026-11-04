'use strict';

// lib/node-support.js: the Node.js versions that `zn-gate check` and `zn-gate status` warn about.
// The warning is advice only; these tests check the message and the level, never an exit code.

const test = require('node:test');
const assert = require('node:assert/strict');
const ns = require('../lib/node-support');

const MB = 1024 * 1024;

test('the constants match the October 2026 Node.js security releases', () => {
  assert.deepEqual(ns.PATCHED_MINIMUM, { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' });
  assert.equal(ns.EOL_BELOW, 22);
  assert.match(ns.ADVISORY_URL, /^https:\/\/nodejs\.org\//);
});

test('patched releases and newer ones give no advice', () => {
  for (const v of ['22.23.4', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0', '22.99.99']) {
    assert.equal(ns.nodeAdvice(v), null, v);
  }
});

test('a release below the first patched one on its line is outdated', () => {
  for (const v of ['22.23.3', '22.0.0', '24.22.0', '26.12.0']) {
    const a = ns.nodeAdvice(v);
    assert.equal(a.level, 'outdated', v);
    assert.equal(a.version, v);
    assert.equal(a.minimum, ns.PATCHED_MINIMUM[Number(v.split('.')[0])], v);
    assert.ok(a.message.includes(ns.ADVISORY_URL));
  }
});

test('end-of-life even lines are reported as eol, with the patched releases listed', () => {
  for (const v of ['20.19.0', '18.20.8', '16.0.0']) {
    const a = ns.nodeAdvice(v);
    assert.equal(a.level, 'eol', v);
    assert.equal(a.minimum, '22.23.4');
    assert.match(a.message, /end-of-life/);
    assert.ok(a.message.includes('22.23.4, 24.22.1, 26.12.1'));
    assert.ok(a.message.includes(ns.ADVISORY_URL));
  }
});

test('odd-numbered lines below the newest listed line are end-of-life', () => {
  for (const v of ['19.9.0', '21.7.3', '23.11.0', '25.0.0']) {
    const a = ns.nodeAdvice(v);
    assert.equal(a.level, 'eol', v);
    assert.equal(a.minimum, '22.23.4');
    assert.match(a.message, /end-of-life/);
  }
});

test('an odd-numbered line newer than every listed one is not judged', () => {
  for (const v of ['27.0.0', '27.3.1', '29.0.0']) {
    assert.equal(ns.nodeAdvice(v), null, v);
  }
});

test('an even line this module does not know yet is not judged', () => {
  assert.equal(ns.nodeAdvice('28.0.0'), null);
});

test('a leading v and surrounding whitespace are accepted', () => {
  assert.equal(ns.nodeAdvice('v22.23.3').version, '22.23.3');
  assert.equal(ns.nodeAdvice('  v20.1.0\n').version, '20.1.0');
});

test('values that are not a version give no advice', () => {
  for (const v of [undefined, null, 42, '', 'node', '22', '22.23', 'x22.23.3']) {
    assert.equal(ns.nodeAdvice(v), null, String(v));
  }
});

test('a 1 MB version string is read within the time bound', () => {
  const t0 = Date.now();
  assert.equal(ns.nodeAdvice('22.' + '1'.repeat(MB)), null);
  assert.equal(ns.nodeAdvice('22.23.' + '9'.repeat(MB)), null);
  assert.equal(ns.nodeAdvice('20.19.' + '0'.repeat(MB)).level, 'eol');
  assert.ok(Date.now() - t0 < 2000, 'took too long');
});

test('a prerelease of the patched version is not the patched release', () => {
  // A prerelease sorts below its release (semver), so 22.23.4-rc.1 is outdated, while 22.23.5-rc.1 is past 22.23.4.
  const a = ns.nodeAdvice('22.23.4-rc.1');
  assert.equal(a.level, 'outdated');
  assert.equal(a.minimum, '22.23.4');
  assert.match(a.message, /22\.23\.4-rc\.1/);
  assert.equal(ns.nodeAdvice('v22.23.4-rc.1').level, 'outdated');
  assert.equal(ns.nodeAdvice('22.23.4'), null);
  assert.equal(ns.nodeAdvice('22.23.5-rc.1'), null);
  assert.equal(ns.nodeAdvice('24.22.1-nightly20261020abc'), null);
  assert.equal(ns.nodeAdvice('24.22.1-beta.0').level, 'outdated');
});
