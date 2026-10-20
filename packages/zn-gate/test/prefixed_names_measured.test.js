'use strict';

// Measured coverage of credentials under prefixed variable names, in the
// rules engine (redactSecrets) and the scrubber (findPatterns). The Python
// package runs the same forms (tests/test_prefixed_names_measured.py).
// Values are synthetic and built from pieces.

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets } = require('../lib/rules');
const { findPatterns } = require('../lib/scrub/patterns');

const VALUE = 'Zx9' + 'kQ2mN8pL' + '4rT6vW1y' + 'Hc5J0';

const CAUGHT = [
  'OPENAI_API_KEY=' + VALUE,
  'MY_APP_DB_PASSWORD=' + VALUE,
  'export X_SECRET=' + VALUE,
  'AWS_SECRET_ACCESS_KEY=' + VALUE,
  'MY_SERVICE_AUTH_TOKEN=' + VALUE,
  'export OPENAI_API_KEY="' + VALUE + '"',
  "OPENAI_API_KEY='" + VALUE + "'",
  'OPENAI_API_KEY = ' + VALUE,
  'OPENAI_API_KEY: ' + VALUE,
  '{"OPENAI_API_KEY": "' + VALUE + '"}',
  'env:\n  MY_APP_SECRET_KEY: ' + VALUE,
  '- OPENAI_API_KEY=' + VALUE,
  'docker run -e OPENAI_API_KEY=' + VALUE + ' img',
  'ENV OPENAI_API_KEY=' + VALUE,
  'set OPENAI_API_KEY=' + VALUE,
];

const KEPT = [
  'OPENAI_API_KEY=YOUR_KEY_HERE_PLACEHOLDER',
  'OPENAI_API_KEY=<your-api-key-here-xxxx>',
  'OPENAI_API_KEY=${OPENAI_API_KEY_VALUE}',
  'MY_APP_DB_PASSWORD=$DB_PASSWORD_FROM_VAULT',
  'OPENAI_API_KEY=changeme',
  'OPENAI_API_KEY=',
  'const OPENAI_API_KEY = process.env.OPENAI_API_KEY_NAME_X;',
  'MAX_TOKEN_COUNT=1234567890123',
  'PASSWORD_MIN_LENGTH=1234567890123',
  'KEY_FILE_PATH=/etc/ssl/certs/ca-bundle.crt',
];

test('rules engine redacts prefixed credential names in env, JSON, YAML and shell forms', () => {
  for (const text of CAUGHT) {
    const { sanitized, detections } = redactSecrets(text);
    assert.ok(!sanitized.includes(VALUE), `not redacted: ${text}`);
    assert.ok(detections.length > 0, `no detection: ${text}`);
  }
});

test('rules engine leaves placeholders, references and non-secret settings alone', () => {
  for (const text of KEPT) {
    const { sanitized, detections } = redactSecrets(text);
    assert.equal(sanitized, text);
    assert.deepEqual(detections, []);
  }
});

test('scrubber finds prefixed credential names on their own line', () => {
  for (const text of CAUGHT) {
    assert.ok(findPatterns(text).length > 0, `no detection: ${text}`);
  }
});

test('scrubber leaves placeholders, references and non-secret settings alone', () => {
  for (const text of KEPT) {
    assert.deepEqual(findPatterns(text), [], text);
  }
});
