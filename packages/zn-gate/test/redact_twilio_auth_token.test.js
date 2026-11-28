'use strict';

// redactSecrets names a Twilio auth token with its own rule and label, as the Python package does, and does not
// take the value under the generic credential rules. Fake values only, built at run time.

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets } = require('../lib/rules');

const TOKEN = 'deadbeef' + '0123456789abcdef'.slice(0, 8) + 'cafebabe' + '00000000';

test('a Twilio auth token gets its own rule and label', () => {
  for (const input of [
    'TWILIO_AUTH_TOKEN=' + TOKEN,
    'auth_token: ' + TOKEN,
    '{"auth_token": "' + TOKEN + '"}',
    'twilio_auth_token = ' + TOKEN.toUpperCase(),
  ]) {
    const { sanitized, detections } = redactSecrets(input);
    assert.ok(!sanitized.toLowerCase().includes(TOKEN), input);
    assert.match(sanitized, /\[REDACTED_TWILIO_AUTH_TOKEN\]/, input);
    assert.deepEqual(detections.map((d) => d.rule), ['secret:twilio_auth_token'], input);
  }
});

test('an unlabelled 32-hex value, or one without digits or letters, is not a Twilio auth token', () => {
  assert.equal(redactSecrets('checksum=' + TOKEN).detections.some((d) => d.rule === 'secret:twilio_auth_token'), false);
  assert.equal(redactSecrets('auth_token=' + 'a'.repeat(32)).detections.some((d) => d.rule === 'secret:twilio_auth_token'), false);
  assert.equal(redactSecrets('auth_token=' + '1'.repeat(32)).detections.some((d) => d.rule === 'secret:twilio_auth_token'), false);
});
