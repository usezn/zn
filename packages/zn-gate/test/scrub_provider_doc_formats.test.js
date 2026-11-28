'use strict';
/**
 * Provider formats read from each vendor's own documentation: the Artifactory reference token (cmVmd, 64
 * characters), the Dynatrace dt0s0x token family, a 1Password service account token with a base64url body
 * and a SendGrid key longer than 69 characters. Every key is fake and built at run time from a fixed
 * alphabet and its public prefix, so no whole key sits in this file. Python has the same cases
 * (tests/test_scrubber_provider_doc_formats.py) and compares its output with this engine's.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/scrub/patterns');
const { redactSecrets } = require('../lib/rules');

const AL = 'Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4Fg6Hj0Ks';
const UR = AL + '-_';
const B64 = AL + '+/';
const body = (n, alphabet = AL) => Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join('');
const types = (text) => P.findPatterns(text, {}).map((s) => s.type);
const leaks = (secret, out) => {
  for (let i = 0; i + 12 <= secret.length; i += 3) if (out.includes(secret.slice(i, i + 12))) return true;
  return false;
};

const POSITIVES = [
  ['ARTIFACTORY_REFERENCE_TOKEN', 'cmVmd' + body(59)],
  ['DYNATRACE_PLATFORM_TOKEN', 'dt0s01.' + body(24) + '.' + body(64)],
  ['DYNATRACE_PLATFORM_TOKEN', 'dt0s02.' + body(24) + '.' + body(64)],
  ['DYNATRACE_PLATFORM_TOKEN', 'dt0s16.' + body(24) + '.' + body(64)],
  ['DYNATRACE_PLATFORM_TOKEN', 'dt0s09.' + body(24) + '.' + body(64)],
  ['ONEPASSWORD_SA_TOKEN_BASE64URL', 'ops_eyJ' + body(250, UR)],
  ['ONEPASSWORD_SA_TOKEN_BASE64URL', 'ops_eyJ' + body(634, UR)],
  ['SENDGRID_KEY_LONG', 'SG.' + body(22, UR) + '.' + body(44, UR)],
  ['SENDGRID_KEY_LONG', 'SG.' + body(22, UR) + '.' + body(46, UR)],
  ['SENDGRID_KEY_LONG', 'SG.' + body(23, UR) + '.' + body(43, UR)],
  ['SENDGRID_KEY_LONG', 'SG.' + body(33, UR) + '.' + body(43, UR)],
  ['SENDGRID_KEY_LONG', 'SG.' + body(30, UR) + '.' + body(66, UR)],
  ['SENDGRID_KEY_LONG', 'SG.' + body(22, UR) + '.' + body(64, UR)],
];

const NEAR_MISSES = [
  ['ARTIFACTORY_REFERENCE_TOKEN', 'cmVmd' + body(58)],
  ['ARTIFACTORY_REFERENCE_TOKEN', 'cmVmd' + body(60)],
  ['ARTIFACTORY_REFERENCE_TOKEN', 'x' + 'cmVmd' + body(59)],
  ['ARTIFACTORY_REFERENCE_TOKEN', 'cmVmd' + 'a'.repeat(59)],
  ['DYNATRACE_PLATFORM_TOKEN', 'dt0s01.' + body(23) + '.' + body(64)],
  ['DYNATRACE_PLATFORM_TOKEN', 'dt0s01.' + body(24) + '.' + body(63)],
  ['DYNATRACE_PLATFORM_TOKEN', 'dt0s1.' + body(24) + '.' + body(64)],
  ['DYNATRACE_PLATFORM_TOKEN', 'dt0s001.' + body(24) + '.' + body(64)],
  ['DYNATRACE_PLATFORM_TOKEN', 'adt0s01.' + body(24) + '.' + body(64)],
  ['ONEPASSWORD_SA_TOKEN_BASE64URL', 'ops_eyJ' + body(249, UR)],
  ['ONEPASSWORD_SA_TOKEN_BASE64URL', 'xops_eyJ' + body(250, UR)],
  ['SENDGRID_KEY_LONG', 'SG.' + body(21, UR) + '.' + body(43, UR)],
  ['SENDGRID_KEY_LONG', 'SG.' + body(22, UR) + '.' + body(42, UR)],
  ['SENDGRID_KEY_LONG', 'xSG.' + body(22, UR) + '.' + body(44, UR)],
  ['SENDGRID_KEY_LONG', 'SG.xxxxxxxx.yyyyyyyy'],
];

test('documented provider formats: each positive is typed, each near miss is not', () => {
  for (const [type, pos] of POSITIVES) assert.ok(types(pos).includes(type), type + ' ' + pos.length);
  for (const [type, neg] of NEAR_MISSES) assert.ok(!types(neg).includes(type), type + ' near miss ' + neg.length);
});

test('documented provider formats: redactSecrets leaves no readable run of the key', () => {
  for (const [, pos] of POSITIVES) {
    for (const text of [pos, 'the key ' + pos + ' was pasted', 'export SERVICE_VALUE=' + pos + '\n', '{"value": "' + pos + '"}']) {
      const out = redactSecrets(text).sanitized;
      assert.ok(!leaks(pos, out), 'leak in ' + pos.length + ' chars: ' + out.slice(0, 40));
    }
  }
});

test('documented provider formats: the older forms are still found by their own rules', () => {
  assert.ok(types('AKCp' + body(69)).includes('ARTIFACTORY_KEY'));
  assert.ok(types('dt0c01.' + body(24) + '.' + body(64)).includes('DYNATRACE_TOKEN'));
  assert.ok(!types('dt0c01.' + body(24) + '.' + body(64)).includes('DYNATRACE_PLATFORM_TOKEN'));
  assert.ok(types('ops_eyJ' + body(250, B64)).includes('ONEPASSWORD_SA_TOKEN'));
  assert.ok(types('SG.' + body(22, UR) + '.' + body(43, UR)).includes('SENDGRID_KEY'));
  assert.ok(!types('SG.' + body(22, UR) + '.' + body(43, UR)).includes('SENDGRID_KEY_LONG'));
  assert.ok(!types('ops_eyJ' + body(250, B64)).includes('ONEPASSWORD_SA_TOKEN_BASE64URL'));
});

test('the retired Teams connector webhook URL is still redacted', () => {
  const uuid = () => [body(8, '0123456789abcdef'), body(4, '0123456789abcdef'), body(4, '0123456789abcdef'),
    body(4, '0123456789abcdef'), body(12, '0123456789abcdef')].join('-');
  const url = 'https://example.webhook.office.com/webhookb2/' + uuid() + '@' + uuid() + '/IncomingWebhook/' + body(32, '0123456789abcdef') + '/' + uuid();
  assert.ok(types(url).includes('TEAMS_WEBHOOK'));
  assert.ok(!leaks(url.slice(url.indexOf('/webhookb2/')), redactSecrets('hook ' + url).sanitized));
});

test('placeholder bodies of the documented formats are not tokens', () => {
  for (const t of ['cmVmd' + '0'.repeat(59), 'dt0s01.' + 'A'.repeat(24) + '.' + 'B'.repeat(64), 'SG.' + 'x'.repeat(22) + '.' + 'y'.repeat(44)]) {
    assert.deepStrictEqual(types(t), [], t.slice(0, 12));
  }
});
