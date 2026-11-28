'use strict';

// A GitHub token (ghp_, gho_, ghu_, ghs_, ghr_) has a body of 36 to 255 characters: the Node.js redactSecrets used to
// read only 36 to 40 and left a longer one fully readable, while the Python package already redacted it. Fake keys
// only, built here from a seeded generator.

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets } = require('../lib/rules');

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
let seed = 20261128;
function pick(n, chars = ALNUM) {
  let out = '';
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    out += chars[(seed >>> 8) % chars.length];
  }
  return out;
}

const PREFIXES = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'];
const LENGTHS = [36, 40, 41, 60, 100, 255];

test('a GitHub token with a body of 36 to 255 characters is redacted whole', () => {
  for (const prefix of PREFIXES) {
    for (const n of LENGTHS) {
      const body = pick(n);
      const key = prefix + body;
      assert.equal(redactSecrets('see ' + key + ' here').sanitized, 'see [REDACTED_GITHUB_TOKEN] here', prefix + n);
      assert.equal(redactSecrets('GH_TOKEN=' + key + '\n').sanitized.includes(body.slice(0, 8)), false, prefix + n);
      assert.equal(redactSecrets('"' + key + '".').sanitized, '"[REDACTED_GITHUB_TOKEN]".', prefix + n);
    }
  }
});

test('a body shorter than 36 characters is not a token', () => {
  const short = 'ghp_' + pick(35);
  assert.equal(redactSecrets('see ' + short + ' here').sanitized, 'see ' + short + ' here');
});

test('a long body that does not look random is kept, as in the Python package', () => {
  const flat = 'ghp_' + 'a'.repeat(60);
  assert.equal(redactSecrets('see ' + flat + ' here').sanitized, 'see ' + flat + ' here');
});

test('a fine-grained token longer than 82 characters is redacted whole', () => {
  for (const n of [59, 60, 100]) {
    const key = 'github_pat_' + pick(22) + '_' + pick(n);
    assert.equal(redactSecrets('see ' + key + ' here').sanitized, 'see [REDACTED_GITHUB_TOKEN] here', String(n));
  }
});
