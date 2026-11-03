'use strict';

// redactSecrets and redactScanSecrets also read the normalised view of a text (empty quote pairs between word
// characters removed, printable %XX decoded), as the Python redact_secrets and redact_scan_secrets do. Fake
// values only; the exact outputs shared with the Python package are in test/fixtures/scrub_normalised_parity.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets, redactScanSecrets } = require('../lib/rules');
const { scan } = require('../lib/scrub/engine');

const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/' + 'bPxRfiCYEXAMPLEKEY';
const SLACK = 'xox' + 'b-123456789012-1234567890123-Ab3dEf6hIj9kLm2nOp5qRs8t';

test('a secret split by quotes or percent-encoding is redacted over the whole original word', () => {
  const text = 'echo AKIA""IOSFODNN7EXAMPLE now';
  const out = redactSecrets(text);
  assert.equal(out.sanitized, 'echo [REDACTED_AWS_KEY] now');
  assert.deepEqual(out.detections, [{ rule: 'secret:aws_access_key', index: 5 }]);
  assert.equal(redactSecrets('%41KIAIOSFODNN7EXAMPLE').sanitized, '[REDACTED_AWS_KEY]');
  assert.equal(redactSecrets('echo gh""p_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8').sanitized, 'echo [REDACTED_GITHUB_TOKEN]');
});

test('the rules of lib/rules.js see the normalised view, not only the scrubber provider formats', () => {
  // GITHUB_TOKEN and ANTHROPIC_KEY are not scrubber provider formats here: only the rules of rules.js redact them.
  assert.equal(redactSecrets('echo sk-ant-api03-xxxxxxxxxx""Fq9Zt2Lm8Pw4Rk7Vn3Hs6Jd1').sanitized, 'echo [REDACTED_ANTHROPIC_KEY]');
  assert.equal(redactSecrets('auth_token%3Dsk-ant-api03-xxxxxxxxxxFq9Zt2Lm8Pw4Rk7Vn3Hs6Jd1').sanitized, 'auth_token%3D[REDACTED_ANTHROPIC_KEY]');
  assert.equal(redactSecrets('api_key=fake""SecretValue1234XyZ').sanitized, 'api_key=[REDACTED_SECRET]');
});

test('a key assigned inside a JSON string and a key in a URL query are redacted; other names and placeholders stay', () => {
  const esc = '\\"';
  assert.equal(redactSecrets('{"cmd":"export next_page_token=' + esc + AWS_SECRET + esc + '"}').sanitized,
    '{"cmd":"export next_page_token=' + esc + '[REDACTED_SECRET]' + esc + '"}');
  assert.equal(redactSecrets('GET /v1/items?client_secret=fakeSecretValue1234 HTTP/1.1').sanitized,
    'GET /v1/items?client_secret=[REDACTED_SECRET] HTTP/1.1');
  for (const text of [
    '{"cmd": "export log_level=' + esc + 'fakeSecretValue1234' + esc + '"}',
    '{"cmd": "export api_key=' + esc + 'your-api-key-here' + esc + '"}',
    'https://example.com/p?page=2&sort=name&q=fakeSecretValue1234',
    'https://example.com/p?token=short',
  ]) assert.equal(redactSecrets(text).sanitized, text);
});

test('an AWS secret after the words aws and secret is redacted with its own label, with or without escaped quotes', () => {
  assert.equal(redactSecrets('the aws secret is ' + AWS_SECRET).sanitized, 'the aws secret is [REDACTED_AWS_SECRET]');
  assert.equal(redactSecrets('{"cmd":"export AWS_SECRET_ACCESS_KEY=\\"' + AWS_SECRET + '\\""}').sanitized,
    '{"cmd":"export AWS_SECRET_ACCESS_KEY=\\"[REDACTED_AWS_SECRET]\\""}');
});

test('quoted token and password values are a scan rule: encoded or not, redactSecrets leaves them and the scan pair redacts them', () => {
  for (const text of ['token: "' + AWS_SECRET + '"', 'token: "wJalrXUtnFEMI/K7MDENG/bPxRfiCY%45XAMPLEKEY"', 'password: "fake%53ecretValue1234XyZ"']) {
    assert.equal(redactSecrets(text).sanitized, text, text);
    assert.notEqual(redactScanSecrets(text).sanitized, text, text);
  }
});

test('redactScanSecrets runs the provider formats like redactSecrets, then the scan rules', () => {
  assert.equal(redactScanSecrets('key ' + SLACK).sanitized, 'key [REDACTED_SLACK_TOKEN]');
  assert.equal(redactScanSecrets('echo AKIA""IOSFODNN7EXAMPLE').sanitized, 'echo [REDACTED_AWS_KEY]');
  assert.ok(!redactScanSecrets('--api-key=%66akeSecretValue1234').sanitized.includes('akeSecret'));
  assert.equal(redactSecrets('key ' + SLACK).sanitized, 'key [REDACTED_SLACK_TOKEN]');
});

test('ordinary quotes, empty strings and encoded spaces are untouched', () => {
  for (const text of [
    'echo "hello" "world"', "echo 'a' 'b'", '{"name": "", "x": ""}', 'echo ""',
    'GET /a%20b/c%20d?q=hello%20world HTTP/1.1', 'discount is 50% off', 'bad %zz and %4',
  ]) {
    assert.equal(redactSecrets(text).sanitized, text);
    assert.equal(redactScanSecrets(text).sanitized, text);
    assert.deepEqual(redactSecrets(text).detections, []);
  }
});

test('texts that are not strings come back as they are', () => {
  assert.equal(redactSecrets('').sanitized, '');
  assert.equal(redactSecrets(undefined).sanitized, undefined);
  assert.equal(redactScanSecrets('').sanitized, '');
});

test('the scrubber engine leaves the normalised view to the caller when asked', () => {
  const text = 'echo ' + SLACK.slice(0, 6) + '""' + SLACK.slice(6);
  assert.equal(scan(text, { exact: false, pii: false }).length, 1);
  assert.equal(scan(text, { exact: false, pii: false, normalise: false }).length, 0);
  // The view is decoded once, not twice: %2541 stays %41.
  assert.equal(redactSecrets('%2541KIAIOSFODNN7EXAMPLE').sanitized, '%2541KIAIOSFODNN7EXAMPLE');
});

test('redaction stays linear on one megabyte of encoded letters, empty quote pairs and plain words', () => {
  for (const unit of ['%41', 'a""', 'word ']) {
    const text = unit.repeat(Math.ceil(1000000 / unit.length));
    const t0 = process.hrtime.bigint();
    redactSecrets(text);
    redactScanSecrets(text);
    const took = Number(process.hrtime.bigint() - t0) / 1e9;
    assert.ok(took < 10, 'took ' + took.toFixed(2) + ' s on 1 MB of ' + JSON.stringify(unit));
  }
});
