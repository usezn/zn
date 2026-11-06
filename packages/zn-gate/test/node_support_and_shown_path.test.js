'use strict';

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { nodeAdvice, PATCHED_MINIMUM } = require('../lib/node-support');
const { fsErrorText } = require('../lib/errors');
const { tempDir } = require('./helpers/tmp');

/* atLeast and shownPath are internal: they are checked through nodeAdvice and fsErrorText. */

test('a version equal to the patched minimum gets no advice, with or without a prefix v', () => {
  for (const min of Object.values(PATCHED_MINIMUM)) {
    assert.equal(nodeAdvice(min), null, min);
    assert.equal(nodeAdvice('v' + min), null, 'v' + min);
  }
});

test('a lower patch, minor or build of a supported line is outdated, with or without a prefix v', () => {
  for (const v of ['22.23.3', 'v22.23.3', '24.21.9', 'v24.21.9', '26.12.0', 'v26.11.99']) {
    const a = nodeAdvice(v);
    assert.equal(a.level, 'outdated', v);
    assert.equal(a.version, v.replace(/^v/, ''), v);
  }
});

test('a higher patch, minor or build of a supported line gets no advice', () => {
  for (const v of ['22.23.5', 'v22.24.0', '24.22.2', '24.100.0', 'v26.12.2', '26.13.0']) {
    assert.equal(nodeAdvice(v), null, v);
  }
});

test('a prefix v does not change the advice', () => {
  for (const v of ['18.0.0', '20.1.2', '22.0.0', '24.22.0', '22.23.4', '25.0.0']) {
    assert.deepEqual(nodeAdvice('v' + v), nodeAdvice(v), v);
  }
});

test('a temporary file name is shown as the file the person knows', (t) => {
  const dir = tempDir(t, 'zn-shown-');
  const real = path.join(dir, 'settings.json');
  for (const tmp of ['.settings.json.zn-tmp.4321.1793200000000', '.settings.json.4321.0a1b2c3d.zn-tmp']) {
    const text = fsErrorText({ code: 'ENOENT', path: path.join(dir, tmp) }, null, {}, 'linux');
    assert.equal(text, real + ' does not exist, or a folder on its path is missing.');
  }
});

test('an ordinary path is shown unchanged', (t) => {
  const dir = tempDir(t, 'zn-shown-');
  for (const name of ['settings.json', '.hidden', '.settings.json.bak']) {
    const p = path.join(dir, name);
    assert.equal(fsErrorText({ code: 'EISDIR', path: p }, null, {}, 'linux'), p + ' is a folder where a file should be.');
  }
});

test('a path under the home folder is shown in full, not with a tilde', (t) => {
  const home = tempDir(t, 'zn-home-');
  const p = path.join(home, '.config', 'example', 'config.json');
  const text = fsErrorText({ code: 'EACCES', path: p }, null, { HOME: home }, 'linux');
  assert.ok(text.includes(p), text);
  assert.ok(!text.includes('~'), text);
});
