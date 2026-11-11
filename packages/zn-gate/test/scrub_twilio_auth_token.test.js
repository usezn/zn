'use strict';

// A Twilio account SID (AC + 32 hex) written next to its auth token (32 hex under
// a TWILIO_AUTH_TOKEN key). The SID is an identifier, not a secret, so it must stay
// visible. The token must be masked. Fake values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/scrub/engine');

const SID = 'AC' + '0123456789abcdef'.repeat(2); // fake, built at run time
const TOKEN = 'deadbeef00000000deadbeef00000000';

function memoryVault() {
  const byKey = new Map();
  const counters = new Map();
  return {
    async mapToken(project, type, value) {
      const k = type + '\0' + value;
      if (!byKey.has(k)) {
        const n = (counters.get(type) || 0) + 1;
        counters.set(type, n);
        byKey.set(k, '__ZN_' + type + '_' + n + '__');
      }
      return byKey.get(k);
    },
    async exactValues() { return []; },
    async audit() {},
  };
}

const ctx = () => ({ project: '/work/app', agent: 'test', tool: 'Read', destination: 'assistant', vault: memoryVault(), env: {}, exactFiles: false, pii: false });
const redact = async (text) => (await E.tokenize(text, ctx())).text;

const SAMPLES = [
  'TWILIO_ACCOUNT_SID=' + SID + ' TWILIO_AUTH_TOKEN=' + TOKEN + '\n',
  'TWILIO_ACCOUNT_SID=' + SID + '\nTWILIO_AUTH_TOKEN=' + TOKEN + '\n',
  'account_sid: ' + SID + '\nauth_token: ' + TOKEN + '\n',
  'export TWILIO_ACCOUNT_SID=' + SID + '\nexport TWILIO_AUTH_TOKEN=' + TOKEN + '\n',
  'account_sid: "' + SID + '"\nauth_token: \'' + TOKEN + '\'\n',
  '{"account_sid": "' + SID + '", "auth_token": "' + TOKEN + '"}\n',
];

test('a Twilio account SID next to an auth token stays visible', async () => {
  for (const input of SAMPLES) {
    const out = await redact(input);
    assert.ok(out.includes(SID), 'SID was masked in: ' + JSON.stringify(input));
  }
});

test('a Twilio auth token next to an account SID is masked', async () => {
  for (const input of SAMPLES) {
    const out = await redact(input);
    assert.ok(!out.includes(TOKEN), 'token was not masked in: ' + JSON.stringify(input));
  }
});

test('an unlabelled 32-hex value is not masked', async () => {
  const hash = 'deadbeef00000000deadbeef00000000';
  const inputs = [
    'md5: ' + hash + '\n',
    'request_id=' + hash + '\n',
    'oauth_token_hash: ' + hash + '\n',
    'etag "' + hash + '"\n',
  ];
  for (const input of inputs) {
    const out = await redact(input);
    assert.ok(out.includes(hash), 'value was masked in: ' + JSON.stringify(input));
  }
});

test('the label and the value are read in any case', async () => {
  for (const input of ['twilio_auth_token=' + TOKEN.toUpperCase() + '\n', 'Auth_Token: ' + TOKEN + '\n']) {
    const out = await redact(input);
    assert.ok(!out.toLowerCase().includes(TOKEN), 'token was not masked in: ' + JSON.stringify(input));
    assert.match(out, /__ZN_TWILIO_AUTH_TOKEN_\d+__/);
  }
});
