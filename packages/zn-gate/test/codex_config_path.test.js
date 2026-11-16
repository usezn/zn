'use strict';

// Codex adapter: where the config folder is. CODEX_HOME wins when set;
// otherwise it is .codex under the home folder. A CODEX_HOME that points to a
// folder that does not exist is still used as given. Values are fake.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const codex = require('../lib/agents/codex');
const { tempDir } = require('./helpers/tmp');

test('CODEX_HOME set: hooks.json is in that folder', (t) => {
  const home = tempDir(t, 'zn-codex-home-');
  const custom = path.join(tempDir(t, 'zn-codex-custom-'), 'codex-config');
  fs.mkdirSync(custom);
  const file = codex.hooksFile({ env: { CODEX_HOME: custom }, home });
  assert.equal(file, path.join(custom, 'hooks.json'));
  assert.equal(codex.detect({ env: { CODEX_HOME: custom, PATH: '' }, home }), true);
});

test('CODEX_HOME unset or empty: hooks.json is in .codex under the home folder', (t) => {
  const home = tempDir(t, 'zn-codex-home-');
  const expected = path.join(home, '.codex', 'hooks.json');
  assert.equal(codex.hooksFile({ env: {}, home }), expected);
  assert.equal(codex.hooksFile({ env: { CODEX_HOME: '' }, home }), expected);
  // No .codex folder yet and no codex program on PATH: not detected.
  assert.equal(codex.detect({ env: { PATH: '' }, home }), false);
  fs.mkdirSync(path.join(home, '.codex'));
  assert.equal(codex.detect({ env: { PATH: '' }, home }), true);
});

test('CODEX_HOME pointing to a missing folder: the path is used and not created', (t) => {
  const home = tempDir(t, 'zn-codex-home-');
  fs.mkdirSync(path.join(home, '.codex'));
  const missing = path.join(tempDir(t, 'zn-codex-custom-'), 'does-not-exist');
  const env = { CODEX_HOME: missing, PATH: '' };
  assert.equal(codex.hooksFile({ env, home }), path.join(missing, 'hooks.json'));
  // The default folder is ignored even though it exists.
  assert.equal(codex.detect({ env, home }), false);
  assert.equal(fs.existsSync(missing), false);
});

test('a relative CODEX_HOME is resolved to an absolute path', () => {
  const file = codex.hooksFile({ env: { CODEX_HOME: 'rel-codex' }, home: '/unused' });
  assert.equal(file, path.join(path.resolve('rel-codex'), 'hooks.json'));
});
