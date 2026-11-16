'use strict';

// The scrubber finds a secret under a sensitive key when the assignment sits
// inside a JSON string (backslash-escaped quotes) and when the value is a URL
// query parameter. Values are synthetic. Non-secret parameters stay.

const test = require('node:test');
const assert = require('node:assert/strict');
const { findPatterns } = require('../lib/scrub/patterns');

const V = 'fakeSecretValue1234';

function redacted(text) {
  const spans = findPatterns(text);
  let out = text;
  for (const s of spans.slice().sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + '#' + out.slice(s.end);
  return out;
}

const ESC = '\\"';

test('assignment with escaped quotes inside a JSON string is redacted', () => {
  const forms = [
    '{"cmd": "export api_key=' + ESC + V + ESC + '"}',
    '{"cmd": "API_KEY=' + ESC + V + ESC + ' node app.js"}',
    '{"body": "{' + ESC + 'api_key' + ESC + ': ' + ESC + V + ESC + '}"}',
    'curl -d ' + "'" + '{' + ESC + 'client_secret' + ESC + ':' + ESC + V + ESC + '}' + "'",
    'export token=\\\\"' + V + '\\\\"',
  ];
  for (const f of forms) {
    const out = redacted(f);
    assert.ok(!out.includes(V), 'not redacted: ' + f);
  }
  assert.equal(redacted('{"cmd": "export api_key=' + ESC + V + ESC + '"}'), '{"cmd": "export api_key=' + ESC + '#' + ESC + '"}');
});

test('escaped-quote forms keep ignoring placeholders and short values', () => {
  const kept = [
    '{"cmd": "export api_key=' + ESC + 'short' + ESC + '"}',
    '{"cmd": "export api_key=' + ESC + 'your-api-key-here' + ESC + '"}',
    '{"cmd": "export api_key=' + ESC + '${API_KEY_VALUE}' + ESC + '"}',
    '{"cmd": "export log_level=' + ESC + V + ESC + '"}',
  ];
  for (const f of kept) assert.deepEqual(findPatterns(f), [], f);
});

test('URL query parameter with a sensitive name is redacted up to the next delimiter', () => {
  const cases = [
    ['https://example.com/p?api_key=' + V + '&x=1', 'https://example.com/p?api_key=#&x=1'],
    ['https://example.com/p?x=1&token=' + V, 'https://example.com/p?x=1&token=#'],
    ['https://example.com/p?access_token=' + V + '#frag', 'https://example.com/p?access_token=#' + '#frag'],
    ['GET /v1/items?client_secret=' + V + ' HTTP/1.1', 'GET /v1/items?client_secret=# HTTP/1.1'],
    ['"https://example.com/p?apikey=' + V + '"', '"https://example.com/p?apikey=#"'],
  ];
  for (const [input, want] of cases) assert.equal(redacted(input), want, input);
});

test('benign query parameters and short or placeholder values stay', () => {
  const kept = [
    'https://example.com/p?page=2&sort=name&q=fakeSecretValue1234',
    'https://example.com/p?token=short',
    'https://example.com/p?api_key=your-api-key-here',
    'https://example.com/p?api_key=${API_KEY_FROM_ENV}',
    'https://example.com/p?token=%7B%7Btoken_value%7D%7D',
    'https://example.com/p?next=/login&password_min_length=12',
    'https://example.com/p?key=' + V,
    'https://example.com/p?token=some-descriptive-token-name',
  ];
  for (const f of kept) assert.deepEqual(findPatterns(f), [], f);
});

test('the new forms stay linear on long hostile input', () => {
  const inputs = [
    '?' + 'a'.repeat(200000) + 'token',
    '&' + 'token_'.repeat(40000),
    'api_key=' + '\\'.repeat(200000),
    'api_key' + '\\"'.repeat(100000),
    '?api_key=' + 'A1b2'.repeat(100000),
  ];
  for (const t of inputs) {
    const t0 = process.hrtime.bigint();
    findPatterns(t);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 2000, 'slow (' + ms.toFixed(0) + ' ms) on input of ' + t.length);
  }
});
