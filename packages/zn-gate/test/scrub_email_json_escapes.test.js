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
