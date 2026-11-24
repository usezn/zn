'use strict';
// E-mail spans next to JSON escapes: the mask never cuts an escape (the output of valid JSON stays valid JSON), and
// an escape that decodes to a local-part character is part of the address. Fake addresses on example.com only.
const test = require('node:test');
const assert = require('node:assert');
const { tokenize } = require('../lib/scrub/engine');

const BS = String.fromCharCode(92);
const DOMAIN = ['example', '.com'].join('');
const TOKEN = '__ZN_REDACTED_EMAIL__';
const run = async (text) => (await tokenize(text, {})).text;
const wrap = (v) => '{"v":"' + v + '"}';

test('an e-mail made of JSON unicode escapes is masked whole', async () => {
  for (const local of [BS + 'u0061', BS + 'u0061user', BS + 'u0061' + BS + 'u0062', BS + 'u0061' + BS + 'u0062c', BS + 'u002e' + BS + 'u0061', BS + 'u0041user']) {
    const out = await run(wrap(local + '@' + DOMAIN));
    assert.strictEqual(out, wrap(TOKEN), 'for ' + local);
    JSON.parse(out);
  }
  assert.strictEqual(await run(wrap('to ' + BS + 'u0061user@' + DOMAIN + ' now')), wrap('to ' + TOKEN + ' now'));
});

test('an escape that is not a local-part character is a boundary: the span starts after it', async () => {
  for (const esc of [BS + 'u0020', BS + 'u0000', BS + 'u00e9', BS + 'n', BS + 't']) {
    const out = await run(wrap(esc + 'user@' + DOMAIN));
    assert.strictEqual(out, wrap(esc + TOKEN), 'for ' + esc);
    JSON.parse(out);
    // nothing left between the escape and the @: no address
    const bare = wrap(esc + '@' + DOMAIN);
    assert.strictEqual(await run(bare), bare, 'bare ' + esc);
  }
  assert.strictEqual(await run(BS + 'ud83duser@' + DOMAIN), BS + 'ud83d' + TOKEN);
});

test('an escaped backslash does not make an escape: the letter belongs to the address', async () => {
  assert.strictEqual(await run(wrap(BS + BS + 'nuser@' + DOMAIN)), wrap(BS + BS + TOKEN));
});

test('a plain address is unchanged in behaviour', async () => {
  assert.strictEqual(await run('mail jane@' + DOMAIN + ' now'), 'mail ' + TOKEN + ' now');
});

test('a local part that mixes raw characters and JSON escapes is masked whole', async () => {
  const u = (hex) => BS + 'u' + hex;
  for (const local of [
    'a' + u('0061') + 'bc', 'a' + u('0061'), 'ab' + u('0063') + 'd', u('0061') + 'b' + u('0063') + 'd',
    'x' + u('0061') + 'y' + u('0062') + 'z', u('0061') + u('0062') + 'c' + u('0064'), 'a.' + u('0062'), 'abc' + u('0064'),
  ]) {
    const json = wrap(local + '@' + DOMAIN);
    JSON.parse(json);
    const out = await run(json);
    assert.strictEqual(out, wrap(TOKEN), 'for ' + local);
    JSON.parse(out);
  }
});

test('a raw prefix after a boundary escape starts after the escape', async () => {
  const u = (hex) => BS + 'u' + hex;
  for (const before of [u('0020'), BS + 'n', 'a' + u('0020'), 'a' + BS + 'n', u('00e9')]) {
    for (const local of ['abc', 'a' + u('0062') + 'c', u('0061') + 'bc']) {
      const json = wrap(before + local + '@' + DOMAIN);
      JSON.parse(json);
      const out = await run(json);
      assert.strictEqual(out, wrap(before + TOKEN), 'for ' + before + local);
      JSON.parse(out);
    }
  }
});

test('the 64-character limit counts characters of the address, not the hex digits of its escapes', async () => {
  const u = (hex) => BS + 'u' + hex;
  const esc = (str) => [...str].map((c) => u(c.charCodeAt(0).toString(16).padStart(4, '0'))).join('');
  const locals = [esc('abcdefghijk'), esc('abcdefghijklmnop'), 'r' + esc('abcdefghijk'), esc('abcdefghijk') + 'r'.repeat(50)];
  // one or two escapes and then 60 to 63 raw characters: 61 to 64 characters once decoded, still an address
  for (let raw = 60; raw <= 63; raw++) {
    locals.push(u('0061') + 'r'.repeat(raw));
    if (raw <= 62) locals.push(u('0061') + u('0062') + 'r'.repeat(raw));
  }
  for (const local of locals) {
    const json = wrap(local + '@' + DOMAIN);
    assert.ok(JSON.parse(json).v.split('@')[0].length <= 64);
    const out = await run(json);
    assert.strictEqual(out, wrap(TOKEN), 'for ' + local);
    JSON.parse(out);
  }
  // 65 raw characters before the '@' are not an address: left as they are, still valid JSON
  const long = wrap(u('0061') + 'r'.repeat(64) + '@' + DOMAIN);
  assert.strictEqual(await run(long), long);
});
