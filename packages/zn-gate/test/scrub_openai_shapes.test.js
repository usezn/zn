'use strict';

// The OPENAI_KEY rule of the Node scrubber (lib/scrub/patterns.js) does not
// redact a lower-case hyphenated slug as a key. A key with a plain body keeps
// lower case, upper case and digits; the Helicone, sp-, cp-, eu-, gov-, rl-, lf-
// and none- forms, and the other provider prefixes, still redact. Every value is
// built at run time from a seeded PRNG with a public prefix: fake, never real.

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/scrub/patterns');
const { scan } = require('../lib/scrub/engine');
const { mulberry32 } = require('./fixtures/fake_secrets');

const rnd = mulberry32(20261030);
const pick = (chars, n) => {
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(rnd() * chars.length)];
  return s;
};
const URLSAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const LOWER_SLUG = 'abcdefghijklmnopqrstuvwxyz-';
const HEX = '0123456789abcdef';

// A body with all three classes in it, so the test does not depend on the PRNG draw.
const mixed = (n) => 'aB3' + pick(URLSAFE, n - 3);

const openaiTypes = (text) => P.findPatterns(text).filter((f) => f.type === 'OPENAI_KEY');

// The span scan() returns for the value, with no context word around it.
function coveredBy(v) {
  const text = 'see ' + v + ' here';
  const spans = scan(text, { exact: false, pii: false });
  const start = 4;
  return spans.find((s) => s.start <= start && s.end >= start + v.length) || null;
}

test('a real-shaped OpenAI key with mixed case and digits is redacted', () => {
  const keys = [
    'sk-proj-' + mixed(60),
    'sk-test-' + mixed(48),
    'sk-' + mixed(48),
    'sk-svcacct-' + mixed(50),
    'sk-admin-' + mixed(50),
    'sk-or-v1-' + mixed(64),
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
    assert.equal(coveredBy(v), null, v + ' was redacted by scan()');
  }
});

// Each prefixed form is detected by scan() with no context word.
test('Helicone, sp-, cp-, eu-, gov-, rl-, lf- and none- keys are detected by scan()', () => {
  const forms = [
    'sk-helicone-' + mixed(60),
    'sk-sp-' + mixed(60),
    'sk-cp-' + mixed(60),
    'sk-eu-' + mixed(60),
    'sk-gov-' + mixed(60),
    'sk-rl-' + mixed(60),
    'sk-lf-' + mixed(60),
    'sk-none-' + mixed(60),
  ];
  for (const v of forms) {
    const span = coveredBy(v);
    assert.ok(span, v.slice(0, 12) + ' not detected by scan()');
    assert.equal(span.end - span.start, v.length, v.slice(0, 12) + ' not fully covered');
  }
});

test('the 32-character hex legacy form is detected by scan()', () => {
  const v = 'sk-' + pick(HEX, 30) + 'a1';
  assert.ok(coveredBy(v), 'legacy hex key not detected by scan()');
});

test('an Anthropic key is still left to its own rule', () => {
  const v = 'sk-ant-api03-' + mixed(93);
  assert.equal(openaiTypes('k ' + v + '\n').length, 0);
});
