'use strict';
/*
 * redactSecrets hides a quoted value with spaces under a secret key up to its
 * closing quote, and a bare number under a quoted secret key without breaking
 * the JSON; the scan stays linear. Same behaviour as the Python redact_secrets
 * (_find_quoted_credentials), which reads the same fixture. Fake values only.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { redactSecrets, redactScanSecrets, QUOTED_CREDENTIAL_RULE } = require('../lib/rules');
const { budget } = require('./helpers/time_budget');

const TOKEN = '[REDACTED_SECRET]';
const FIXTURE = path.join(__dirname, 'fixtures', 'scrub_quoted_kv_parity.json');
const redact = (text) => redactSecrets(text).sanitized;

test('the three reported inputs', () => {
  assert.strictEqual(redact('{"password":"abcdefgh ijk lmn","n":1}'), `{"password":"${TOKEN}","n":1}`);
  assert.strictEqual(redact('password="abcdefgh ijk lmn" x'), `password="${TOKEN}" x`);
  assert.strictEqual(redact('{"token":12345678}'), `{"token":"${TOKEN}"}`);
});

test('shared fixture with the Python redact_secrets ({S} is one replaced secret)', () => {
  const cases = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).cases;
  assert.ok(cases.length >= 20);
  for (const c of cases) {
    assert.strictEqual(redact(c.input), c.output.split('{S}').join(TOKEN), c.name);
  }
});

test('JSON stays valid', () => {
  assert.deepStrictEqual(JSON.parse(redact('{"password":"abcdefgh ijk lmn","n":1}')), { password: TOKEN, n: 1 });
  assert.deepStrictEqual(JSON.parse(redact('{"token":12345678}')), { token: TOKEN });
  for (const text of [
    '{"max_token":100000000,"x":1}',
    '{"params":{"arguments":{"page_token":123456789}}}',
    '{ "token" : -12345678.5 , "n" : null }',
    '{"api_key":1.2345678e10,"b":[1,2]}',
  ]) {
    const out = redact(text);
    assert.notStrictEqual(out, text);
    assert.doesNotThrow(() => JSON.parse(out), out);
    for (const digits of ['12345678', '100000000', '123456789']) assert.ok(!out.includes(digits), out);
  }
});

test('an escaped JSON string inside a JSON string', () => {
  const inner = '{"command":"echo {\\"password\\":\\"fake pass phrase here\\",\\"n\\":1}"}';
  const out = redact(inner);
  assert.ok(!out.includes('phrase'));
  const parsed = JSON.parse(out);
  assert.deepStrictEqual(Object.keys(parsed), ['command']);
  assert.ok(parsed.command.includes('"n":1'));
  const num = redact('{"command":"echo {\\"token\\":12345678}"}');
  assert.ok(!num.includes('12345678'));
  JSON.parse(num);
});

test('escaped quotes are part of the value', () => {
  const out = redact('{"api_key":"fake key \\"with\\" quotes and spaces","n":1}');
  assert.strictEqual(out, `{"api_key":"${TOKEN}","n":1}`);
  JSON.parse(out);
});

test('values that are left alone', () => {
  for (const text of [
    '{"password":"a b c","n":1}',
    '{"password":"your password here"}',
    '{"token":"${API TOKEN HERE}"}',
    'token: "Bearer ${TOKEN}"',
    '{"token":1234567}',
    '{"token":00000000}',
    '{"token":true,"password":null,"api_key":[1,2,3]}',
    '{"password_hint":"choose a long phrase","token_count":123456789}',
    '{"tokens":123456789,"max_tokens":100000000}',
    'password="unterminated value with spaces',
    'token=12345678 next',
    'password: 123456789012345',
  ]) {
    assert.strictEqual(redact(text), text, text);
  }
});

test('a second pass changes nothing', () => {
  for (const text of ['{"password":"abcdefgh ijk lmn","n":1}', '{"token":12345678}', 'password="abcdefgh ijk lmn" x']) {
    const once = redact(text);
    assert.strictEqual(redact(once), once, text);
  }
});

test('the detection is the value only', () => {
  const text = '{"password":"abcdefgh ijk lmn","n":1}';
  const { detections } = redactSecrets(text);
  assert.strictEqual(detections.length, 1);
  assert.strictEqual(detections[0].rule, QUOTED_CREDENTIAL_RULE);
  assert.strictEqual(detections[0].index, text.indexOf('abcdefgh'));
  const num = redactSecrets('{"token":12345678}');
  assert.strictEqual(num.detections[0].index, '{"token":'.length);
});

test('the rest of a value is not left behind by the assignment rules', () => {
  assert.strictEqual(redact('API_KEY="abcdefghijkl mno pqr" x'), `API_KEY="${TOKEN}" x`);
  assert.strictEqual(redact('{"api_key":"abcdefghijkl mno pqr"}'), `{"api_key":"${TOKEN}"}`);
});

test('invisible characters inside the key or the value', () => {
  assert.strictEqual(redact('{"pass\u200bword":"abcdefgh ijk lmn"}'), `{"pass\u200bword":"${TOKEN}"}`);
  assert.strictEqual(redact('{"password":"abcdefgh\u200b ijk lmn"}'), `{"password":"${TOKEN}"}`);
});

test('the scan redaction uses it too', () => {
  const out = redactScanSecrets('{"password":"abcdefgh ijk lmn","n":1}');
  assert.strictEqual(out.sanitized, `{"password":"${TOKEN}","n":1}`);
  assert.strictEqual(out.detections.length, 1);
});

test('a value past the length cap is left to the other rules', () => {
  const text = '{"password":"' + 'ab cd '.repeat(2000) + '"}';
  assert.strictEqual(redact(text), text);
});

// The same adversarial inputs as the Python test, each under 500 ms.
const MiB = 1024 * 1024;
const INPUTS = [
  'password="'.repeat(50000),
  "token='".repeat(70000),
  '{"password":"'.repeat(40000),
  '"password":\\"'.repeat(40000),
  '"password":\\\\"'.repeat(40000),
  'password="' + '\\"'.repeat(200000),
  'password="' + 'ab cd '.repeat(100000),
  'token=\\" ' + 'token=\\\\" '.repeat(60000),
  'token:' + ' '.repeat(300000) + '"',
  'token '.repeat(100000),
  '{"token":' + '1'.repeat(300000) + '}',
  'password="' + '\\'.repeat(300000),
  'token=\\"' + '\\'.repeat(300000) + '"',
  "token='" + '\\'.repeat(300000),
  // 1 MiB of backslashes after an opener.
  'password="' + '\\'.repeat(MiB),
  'token="' + '\\'.repeat(MiB),
  'token=\\"' + '\\'.repeat(MiB),
];

test('redactSecrets is linear on adversarial inputs (each under 500 ms)', () => {
  for (const [i, text] of INPUTS.entries()) {
    const t0 = process.hrtime.bigint();
    redactSecrets(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < budget(500), `input ${i} (${text.length} characters) took ${ms.toFixed(0)} ms`);
  }
});

test('many values after an invisible character stay linear (time grows with the size, not its square)', () => {
  // One invisible character makes a second pass, whose spans are compared with those
  // of the first. Four times the text must take about four times as long: a quadratic
  // count would take sixteen. The ratio does not depend on the speed of the machine.
  const time = (text) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = process.hrtime.bigint();
      redactSecrets(text);
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return best;
  };
  for (const member of ['"api_key":"q7a1b2c3d4e5f6a7b8",', '"token":12345678901,']) {
    const small = '\u200b' + member.repeat(Math.floor(MiB / 4 / member.length));
    const large = '\u200b' + member.repeat(Math.floor(MiB / member.length));
    const ratio = time(large) / Math.max(time(small), 1);
    assert.ok(ratio < 9, `1 MiB took ${ratio.toFixed(1)} times as long as 256 KiB`);
    const out = redactSecrets(large).sanitized;
    assert.ok(!out.includes('q7a1b2c3') && !out.includes('12345678901'));
  }
});
