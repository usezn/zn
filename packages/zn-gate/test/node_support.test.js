'use strict';

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nodeAdvice, ADVISORY_URL } = require('../lib/node-support');
const { check, report } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

test('end-of-life lines get a warning that points at 22.23.4', () => {
  for (const v of ['18.20.0', 'v18.0.0', '20.19.0', '20.99.9']) {
    const a = nodeAdvice(v);
    assert.equal(a.level, 'eol', v);
    assert.equal(a.minimum, '22.23.4');
    assert.ok(a.message.includes('end-of-life') && a.message.includes(ADVISORY_URL), v);
  }
});

test('a supported line below its patched release is outdated, at or above it is fine', () => {
  const cases = [['22.23.3', '22.23.4'], ['22.22.9', '22.23.4'], ['22.0.0', '22.23.4'], ['24.22.0', '24.22.1'], ['26.12.0', '26.12.1'], ['26.11.9', '26.12.1']];
  for (const [v, min] of cases) {
    const a = nodeAdvice(v);
    assert.equal(a.level, 'outdated', v);
    assert.equal(a.minimum, min);
    assert.ok(a.message.includes('Node.js ' + min + ' or later'), v);
  }
  for (const v of ['22.23.4', '22.24.0', '22.100.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0', 'v24.22.1']) assert.equal(nodeAdvice(v), null, v);
});

test('odd lines below the newest listed line are end-of-life', () => {
  for (const v of ['25.0.0', '25.9.1', '23.5.0', '21.0.0']) assert.equal(nodeAdvice(v).level, 'eol', v);
});

test('newer lines, nightlies and garbage get no warning', () => {
  for (const v of ['27.1.0', '28.0.0', '22', '22.23', '', null, undefined, 'abc', 'node', {}, 42]) assert.equal(nodeAdvice(v), null, String(v));
  assert.equal(nodeAdvice('24.22.1-nightly20261101abc'), null);
});

test('check reports the warning for this Node.js and for the one the hooks run on, and keeps the exit code', async (t) => {
  const home = tempDir(t, 'zn-nodewarn-home-');
  const cwd = tempDir(t, 'zn-nodewarn-cwd-');
  const env = { HOME: home, PATH: process.env.PATH };
  const run = async (opts) => {
    const res = await check({ home, env, cwd, live: false, ...opts });
    let out = '';
    const code = report(res, (s) => { out += s; });
    return { res, out, code };
  };
  const old = await run({ nodeVersion: '20.19.0' });
  assert.equal(old.res.warnings.length, 1);
  assert.match(old.out, /Warning: Node\.js 20\.19\.0 is end-of-life.*22\.23\.4 or later/);
  const fine = await run({ nodeVersion: '22.23.4' });
  assert.deepEqual(fine.res.warnings, []);
  assert.doesNotMatch(fine.out, /Warning: Node\.js/);
  assert.equal(old.code, fine.code, 'a warning never changes the exit code');
  const hooks = await run({ nodeVersion: '24.22.1', hookNode: { version: '22.23.3', path: '/usr/bin/node' } });
  assert.equal(hooks.res.warnings.length, 1);
  assert.match(hooks.res.warnings[0], /hooks will run on Node\.js 22\.23\.3 \(from \/usr\/bin\/node\).*22\.23\.4 or later/);
});
