'use strict';

// The OPENAI_KEY rule of the Node scrubber (lib/scrub/patterns.js) takes the
// same keys as the Python scrubber: the body must hold lower case, upper case
// and digits, and the Helicone, sp-, cp- and similar forms are left out. A
// lower-case slug with hyphens is not a key. Every value is built at run time
// from a seeded PRNG with a public prefix: fake, never real.

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/scrub/patterns');
const { mulberry32 } = require('./fixtures/fake_secrets');

const rnd = mulberry32(20261030);
const pick = (chars, n) => {
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(rnd() * chars.length)];
  return s;
};
const URLSAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const LOWER_SLUG = 'abcdefghijklmnopqrstuvwxyz-';

// A body with all three classes in it, so the test does not depend on the PRNG draw.
const mixed = (n) => 'aB3' + pick(URLSAFE, n - 3);

const openaiTypes = (text) => P.findPatterns(text).filter((f) => f.type === 'OPENAI_KEY');

test('a real-shaped OpenAI key with mixed case and digits is redacted', () => {
  const keys = [
    'sk-proj-' + mixed(60),
    'sk-test-' + mixed(48),
    'sk-' + mixed(48),
    'sk-svcacct-' + mixed(50),
  ];
  for (const v of keys) {
    const found = openaiTypes('OPENAI_API_KEY=' + v + '\n');
    assert.equal(found.length, 1, v.slice(0, 16) + ' not detected');
    assert.equal(found[0].end - found[0].start, v.length, v.slice(0, 16) + ' not fully covered');
  }
});

test('a lower-case hyphenated slug of 40 or more characters is not a key', () => {
  const slugs = [
    'sk-this-is-a-long-lowercase-slug-for-a-blog-post-title',
    'sk-' + pick(LOWER_SLUG, 60),
    'sk-my-long-kebab-case-identifier-with-many-words-here',
  ];
  for (const v of slugs) {
    assert.equal(openaiTypes('title: ' + v + '\n').length, 0, v + ' was taken for a key');
  }
});

test('Helicone, sp-, cp- and similar forms are left to the shared rules', () => {
  const forms = [
    'sk-helicone-' + mixed(60),
    'sk-sp-' + mixed(60),
    'sk-cp-' + mixed(60),
    'sk-eu-' + mixed(60),
    'sk-none-' + mixed(60),
  ];
  for (const v of forms) {
    assert.equal(openaiTypes('key ' + v + '\n').length, 0, v.slice(0, 12) + ' matched the OpenAI rule');
  }
});

test('the 32-character hex form of a legacy key is still detected', () => {
  const v = 'sk-' + pick('0123456789abcdef', 30) + 'a1';
  assert.equal(openaiTypes('key ' + v + '\n').length, 1);
});
