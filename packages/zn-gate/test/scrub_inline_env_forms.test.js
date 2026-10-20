'use strict';

// The scrubber (line-based patterns) finds a credential in two shell forms:
// a PowerShell `$env:NAME = value` assignment and an inline assignment
// before a command (`NAME=value node app.js`). Values are synthetic and
// built from pieces; placeholders, references and ordinary settings stay.

const test = require('node:test');
const assert = require('node:assert/strict');
const { findPatterns } = require('../lib/scrub/patterns');

const VALUE = 'Zx9' + 'kQ2mN8pL' + '4rT6vW1y' + 'Hc5J0';

function redacted(text) {
  const spans = findPatterns(text);
  let out = text;
  for (const s of spans.slice().sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + '#' + out.slice(s.end);
  return out;
}

const CAUGHT = [
  '$env:OPENAI_API_KEY = ' + VALUE,
  '$env:OPENAI_API_KEY=' + VALUE,
  '$env:OPENAI_API_KEY = "' + VALUE + '"',
  "$env:MY_APP_SECRET = '" + VALUE + "'",
  '  $env:MY_SERVICE_AUTH_TOKEN = ' + VALUE + '  # local only',
  'OPENAI_API_KEY=' + VALUE + ' node app.js',
  'API_KEY=' + VALUE + ' node app.js',
  'OPENAI_API_KEY="' + VALUE + '" node app.js',
  'NODE_ENV=production OPENAI_API_KEY=' + VALUE + ' node app.js',
  'OPENAI_API_KEY=' + VALUE + ' NODE_ENV=production node app.js',
  'env MY_APP_DB_PASSWORD=' + VALUE + ' ./run.sh --port 3000',
];

const KEPT = [
  'NODE_ENV=production node app.js',
  'PORT=3000 npm start',
  'CI=true DEBUG=app:* npm test',
  '$env:PATH = "C:\\Windows;C:\\tools\\bin"',
  '$env:NODE_ENV = "development"',
  '$env:API_KEY_FILE = "C:\\keys\\current.txt"',
  '$env:OPENAI_API_KEY = $env:KEY_FROM_VAULT',
  '$env:OPENAI_API_KEY = "<your-api-key-here>"',
  '$env:OPENAI_API_KEY = ""',
  'OPENAI_API_KEY=YOUR_KEY_HERE_PLACEHOLDER node app.js',
  'OPENAI_API_KEY=${OPENAI_API_KEY_VALUE} node app.js',
  'API_KEY=$API_KEY_FROM_VAULT node app.js',
  'API_KEY=changeme node app.js',
  'OPENAI_API_KEY= node app.js',
  'MAX_TOKEN_COUNT=1234567890123 node app.js',
  'PASSWORD_MIN_LENGTH=1234567890123 node app.js',
  'KEY_FILE_PATH=/etc/ssl/certs/ca-bundle.crt node app.js',
  'API_URL=https://api.example.com/v1/endpoint-path node app.js',
  'SECRET_PATH=/var/run/secrets/kubernetes.io/token node app.js',
];

test('scrubber redacts the value in PowerShell and inline-assignment forms', () => {
  for (const text of CAUGHT) {
    const out = redacted(text);
    assert.ok(!out.includes(VALUE), 'not redacted: ' + text);
    assert.ok(out.includes('#'), 'no detection: ' + text);
  }
});

test('scrubber leaves placeholders, references and ordinary settings in those forms alone', () => {
  for (const text of KEPT) {
    assert.deepEqual(findPatterns(text), [], text);
  }
});

test('the redaction keeps the name and the command around the value', () => {
  assert.equal(redacted('OPENAI_API_KEY=' + VALUE + ' node app.js'), 'OPENAI_API_KEY=# node app.js');
  assert.equal(redacted('$env:OPENAI_API_KEY = ' + VALUE), '$env:OPENAI_API_KEY = #');
});
