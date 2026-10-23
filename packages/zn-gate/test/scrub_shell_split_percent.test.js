'use strict';

// A secret split by shell quoting (AKIA""rest, 'a''b') or written with
// percent-encoding (%41KIA..., api_key%3Dvalue) is redacted as a whole.
// Values are synthetic. Ordinary quotes and %20 stay untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const { scan } = require('../lib/scrub/engine');
const { normalisedView, MAX_DECODES } = require('../lib/scrub/normalize');

const AWS = 'AKIAIOSFODNN7EXAMPLE';
const V = 'fakeSecretValue1234';
const CTX = { exact: false };

function redacted(text) {
  let out = text;
  for (const s of scan(text, CTX).slice().sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + '#' + out.slice(s.end);
  return out;
}

function pct(str) {
  return str.split('').map((ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');
}

test('AWS key split by shell quotes is redacted as one word', () => {
  assert.equal(redacted('echo AKIA""IOSFODNN7EXAMPLE'), 'echo #');
  assert.equal(redacted("echo 'AKIA''IOSFODNN7EXAMPLE'"), "echo '#'");
  assert.equal(redacted('echo "AKIA""IOSFODNN7EXAMPLE"'), 'echo "#"');
  assert.equal(redacted("echo AKIA''IOS''FODNN7EXAMPLE"), 'echo #');
});

test('assignment split by shell quotes is redacted', () => {
  for (const f of [
    "api_key='fakeSecret''Value1234'",
    'api_key=fakeSecret""Value1234',
    'api_key="fakeSecret""Value1234"',
    "export api_key='fake''Secret''Value1234'",
  ]) {
    const out = redacted(f);
    assert.ok(!out.includes('Value1234') && !out.includes('fakeSecret'), 'not redacted: ' + f + ' -> ' + out);
  }
});

test('percent-encoded values are redacted', () => {
  assert.equal(redacted('%41KIAIOSFODNN7EXAMPLE'), '#');
  assert.equal(redacted('key ' + pct(AWS)), 'key #');
  assert.ok(!redacted('api_key=%66akeSecretValue1234').includes('akeSecret'));
  assert.ok(!redacted('api_key=' + pct(V)).includes('%'));
  assert.ok(!redacted('api_key%3D' + V).includes(V));
  assert.equal(redacted('?x=1&api_key%3D' + pct(V)), '?x=1&api_key%3D#');
});

test('ordinary quotes, empty strings and %20 are untouched', () => {
  for (const t of [
    'echo "hello" "world"',
    "echo 'a' 'b'",
    '{"name": "", "x": ""}',
    'echo ""',
    'GET /a%20b/c%20d?q=hello%20world HTTP/1.1',
    'https://example.com/search?q=a%2Fb%26c',
    'path=C:%5CUsers%5Cdemo',
    'discount is 50% off',
    'bad %zz and %4',
  ]) assert.equal(redacted(t), t, t);
});

test('the view decodes only printable ASCII and keeps %20', () => {
  assert.equal(normalisedView('a%20b'), null);
  assert.equal(normalisedView('a%00b%C3%A9'), null);
  const v = normalisedView('x%41y');
  assert.equal(v.clean, 'xAy');
  assert.equal(v.starts[1], 1);
  assert.equal(v.ends[1], 4);
  assert.equal(normalisedView("a''b").clean, 'ab');
  assert.equal(normalisedView("''a"), null);
});

test('work is capped and linear', () => {
  const big = '%41'.repeat(MAX_DECODES + 50000);
  const t0 = Date.now();
  const v = normalisedView(big);
  assert.equal(v.clean.length, MAX_DECODES + 50000 * 3);
  const long = ("a''".repeat(200000)) + '%41'.repeat(100000);
  scan(long, CTX);
  assert.ok(Date.now() - t0 < 5000, 'too slow');
});
