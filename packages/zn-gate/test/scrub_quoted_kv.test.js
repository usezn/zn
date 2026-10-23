'use strict';

// A quoted value with spaces under a secret key is redacted up to its closing
// quote, a bare number under a secret key is redacted without breaking JSON,
// and the scan stays linear. Same behaviour as the Rust scrubber. Fake values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/scrub/engine');
const { findPatterns } = require('../lib/scrub/patterns');

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

test('a quoted password with spaces in JSON is redacted whole and the JSON stays valid', async () => {
  const input = '{"password":"abcdefgh ijk lmn","n":1}';
  const out = await redact(input);
  assert.equal(out, '{"password":"__ZN_SECRET_1__","n":1}');
  assert.deepEqual(JSON.parse(out), { password: '__ZN_SECRET_1__', n: 1 });
});

test('a quoted password with spaces in a shell assignment keeps the text after the closing quote', async () => {
  const out = await redact('password="abcdefgh ijk lmn" x');
  assert.equal(out, 'password="__ZN_SECRET_1__" x');
  assert.equal(await redact("export TOKEN='fake one two three' && run"), "export TOKEN='__ZN_SECRET_1__' && run");
});

test('a number under a secret key is redacted as a quoted string, so the JSON stays valid', async () => {
  const out = await redact('{"token":12345678}');
  assert.equal(out, '{"token":"__ZN_SECRET_1__"}');
  assert.deepEqual(JSON.parse(out), { token: '__ZN_SECRET_1__' });
  for (const input of [
    '{"max_token":100000000,"x":1}',
    '{"params":{"arguments":{"page_token":123456789}}}',
    '{ "token" : -12345678.5 , "n" : null }',
    '{"api_key":1.2345678e10,"b":[1,2]}',
  ]) {
    const o = await redact(input);
    const v = JSON.parse(o);
    assert.notEqual(o, input);
    assert.doesNotMatch(o, /12345678|100000000|123456789/);
    assert.ok(v && typeof v === 'object', o);
  }
  // A single-quoted key gets a single-quoted string; a number under an unquoted key is left alone.
  assert.equal(await redact("{'token': 12345678}"), "{'token': '__ZN_SECRET_1__'}");
  assert.equal(await redact('token=12345678 next'), 'token=12345678 next');
  assert.equal(await redact('password: 123456789012345'), 'password: 123456789012345');
});

test('an escaped JSON string inside a JSON string is redacted at its own level', async () => {
  const inner = '{"command":"echo {\\"password\\":\\"fake pass phrase here\\",\\"n\\":1}"}';
  const out = await redact(inner);
  assert.ok(!out.includes('phrase'), out);
  assert.deepEqual(Object.keys(JSON.parse(out)), ['command']);
  assert.ok(JSON.parse(out).command.includes('"n":1'), out);
  const escapedNumber = '{"command":"echo {\\"token\\":12345678}"}';
  const o2 = await redact(escapedNumber);
  assert.ok(!o2.includes('12345678'), o2);
  JSON.parse(o2);
});

test('escaped quotes inside a quoted value are part of the value', async () => {
  const input = '{"api_key":"fake key \\"with\\" quotes and spaces","n":1}';
  const out = await redact(input);
  assert.equal(out, '{"api_key":"__ZN_SECRET_1__","n":1}');
  JSON.parse(out);
  // A single-quoted value ends at the next single quote; a backslash is just a character.
  assert.equal(await redact("password='fake pass\\ phrase here' ok"), "password='__ZN_SECRET_1__' ok");
});

test('a shell word glued to more quoted pieces is one value', async () => {
  assert.equal(await redact("export password='fake pass phrase here''more' && run"), "export password='__ZN_SECRET_1__' && run");
});

test('short values, placeholders, other keys, booleans and null are left alone', async () => {
  for (const input of [
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
  ]) {
    assert.equal(await redact(input), input, input);
  }
});

test('a second pass over redacted text changes nothing', async () => {
  for (const input of ['{"password":"abcdefgh ijk lmn","n":1}', '{"token":12345678}', 'password="abcdefgh ijk lmn" x']) {
    const once = await redact(input);
    assert.equal(await redact(once), once, input);
  }
});

test('the value is only the span: the key and the quotes stay', () => {
  const text = '{"password":"abcdefgh ijk lmn","n":1}';
  const hits = findPatterns(text, {});
  assert.equal(hits.length, 1);
  assert.equal(text.slice(hits[0].start, hits[0].end), 'abcdefgh ijk lmn');
  const num = '{"token":12345678}';
  const h2 = findPatterns(num, {});
  assert.equal(h2.length, 1);
  assert.equal(num.slice(h2[0].start, h2[0].end), '12345678');
  assert.equal(h2[0].quote, '"');
});

function ms(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

test('a long run of openers, quotes and escapes is scanned in linear time', () => {
  const inputs = [
    'password="'.repeat(50000),
    "token='".repeat(70000),
    '{"password":"'.repeat(40000),
    '"password":\\"'.repeat(40000),
    '"password":\\\\"'.repeat(40000),
    'password="' + '\\"'.repeat(200000),
    'password="' + 'ab cd '.repeat(100000),
    'token=\\" ' + 'token=\\\\" '.repeat(60000),
    'token:' + ' '.repeat(300000) + '"',
    'token ' .repeat(100000),
    '{"token":' + '1'.repeat(300000) + '}',
  ];
  for (const text of inputs) {
    const t = ms(() => E.scan(text, { exact: false, pii: false }));
    assert.ok(t < 3000, 'took ' + t + ' ms on a ' + text.length + '-character input');
  }
});

test('a value past the length cap is left to the other rules and the work stays bounded', async () => {
  const text = '{"password":"' + 'ab cd '.repeat(2000) + '"}';
  assert.equal(await redact(text), text);
});

test('one opener followed by a very long run of backslashes is scanned in linear time', () => {
  const MIB = 1024 * 1024;
  const inputs = [
    'token="' + '\\'.repeat(MIB),
    "token='" + '\\'.repeat(MIB),
    'token=\\"' + '\\'.repeat(MIB),
    'token=\\\\"' + '\\'.repeat(MIB),
    '{"password":"' + '\\'.repeat(MIB),
    'token="' + '\\'.repeat(MIB) + '"',
    'token=\\"' + ('\\'.repeat(100) + 'x').repeat(10000),
  ];
  for (const text of inputs) {
    const t = ms(() => findPatterns(text, {}));
    assert.ok(t < 500, 'took ' + t + ' ms on a ' + text.length + '-character input');
    const t2 = ms(() => E.scan(text, { exact: false, pii: false }));
    assert.ok(t2 < 500, 'scan took ' + t2 + ' ms on a ' + text.length + '-character input');
  }
});

test('a backslash run still ends an escaped value only at its own level', async () => {
  // Level 1: the value ends at exactly one backslash and the quote.
  const out = await redact('{"command":"echo {\\"password\\":\\"fake pass\\\\\\\\ phrase here\\",\\"n\\":1}"}');
  assert.ok(!out.includes('phrase'), out);
  JSON.parse(out);
});
