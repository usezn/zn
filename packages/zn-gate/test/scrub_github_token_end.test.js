'use strict';

// Where a GitHub key ends. The next line is never taken into the redaction when the key is complete and the line
// is a word; a key that wraps onto a line of key material is still redacted whole. Both engines read it the same
// way (Python: tests/test_scrubber_github_token_end.py). Fake keys only, built from a seeded generator.

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets } = require('../lib/rules');

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
let seed = 20261129;
function pick(n, chars = ALNUM) {
  let out = '';
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    out += chars[(seed >>> 8) % chars.length];
  }
  return out;
}
const R = '[REDACTED_GITHUB_TOKEN]';
const randomBody = (n) => {
  for (;;) {
    const b = pick(n);
    if (/[0-9]/.test(b) && /[A-Z]/.test(b) && /[a-z]/.test(b)) return b;
  }
};

test('the next line is kept after a complete key, whatever follows the key', () => {
  const words = ['run-deploy now', 'rundeployment.', 'deploynowplease', 'run_deploy_x --now', 'next.line.here-x', './run-deploy.sh'];
  for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
    for (const n of [36, 40, 60, 100]) {
      for (const word of words) {
        for (const lead of ['export T=', '', 'token: ']) {
          const key = prefix + randomBody(n);
          for (const eol of ['\n', '\r\n']) {
            assert.equal(redactSecrets(lead + key + eol + word + '\n').sanitized, lead + R + eol + word + '\n', prefix + n + word);
          }
        }
      }
    }
  }
});

test('a key followed by punctuation or a hyphen word ends where the key ends', () => {
  const key = 'ghp_' + randomBody(36);
  assert.equal(redactSecrets('x ' + key + '-word y').sanitized, 'x ' + R + '-word y');
  assert.equal(redactSecrets(key + '.next y').sanitized, R + '.next y');
  assert.equal(redactSecrets('(' + key + '),\nfoo').sanitized, '(' + R + '),\nfoo');
  assert.equal(redactSecrets(key + '.\nrun-deploy-now').sanitized, R + '.\nrun-deploy-now');
});

test('a key that wraps onto a line of key material is redacted whole', () => {
  for (const n of [36, 60, 100, 200]) {
    for (const first of [14, 20, 30, 76]) {
      if (first >= n - 9) continue;
      const body = randomBody(n);
      const text = 'export T=ghp_' + body.slice(0, first) + '\n' + body.slice(first) + '\nnext\n';
      const out = redactSecrets(text).sanitized;
      for (let k = 0; k + 8 <= body.length; k++) assert.ok(!out.includes(body.slice(k, k + 8)), n + ':' + first);
      assert.ok(out.endsWith('\nnext\n'), out.slice(-20));
    }
  }
});

test('a long key whose first line is complete and whose rest is key material is redacted whole', () => {
  for (const n of [100, 150, 255]) {
    const body = randomBody(n);
    const text = 'ghp_' + body.slice(0, 76) + '\n' + body.slice(76);
    assert.equal(redactSecrets(text).sanitized, R, String(n));
  }
});
