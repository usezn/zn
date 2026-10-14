'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const policy = require('../lib/hooks/policy');

test('globRegExp compiles any bracket expression', () => {
  const globs = ['[z-a]*', '[a\\]', '[\\', 'x[]y', '[!]', '[^]x', '[]]', '[a-]', '[-a]', '[[:alpha:]]',
    '[$(rm)]', '[.*+?]', '[é-à]', '[\ud83d]'];
  for (const g of globs) assert.doesNotThrow(() => policy.globRegExp(g), g);
});

test('globRegExp keeps the shell meaning of bracket expressions', () => {
  const m = (g, s) => policy.globRegExp(g).test(s);
  assert.ok(m('id_[rd]sa', 'id_rsa'));
  assert.ok(m('id_[a-z]sa', 'id_rsa'));
  assert.ok(!m('id_[!r]sa', 'id_rsa'));
  assert.ok(m('id_[!x]sa', 'id_rsa'));
  assert.ok(m('id_[^x]sa', 'id_rsa'));
  assert.ok(!m('a[!x]b', 'a/b'), 'a negated class never matches "/"');
  assert.ok(!m('[z-a]', 'm'), 'a backwards range matches nothing');
  assert.ok(m('a[\\]', 'a\\'), 'a backslash inside a class is literal');
  assert.ok(m('a[^]b', 'axb'), '"[^]" is a negated empty class');
  assert.ok(m('[.]env', '.env'));
  assert.ok(!m('[.]env', 'xenv'));
});

test('a backwards range in a path no longer breaks the policy', () => {
  const opts = { cwd: os.tmpdir(), home: os.tmpdir(), env: {} };
  assert.doesNotThrow(() => policy.globClass('~/.ssh/[z-a]*', opts));
  assert.doesNotThrow(() => policy.globClass('./[a\\]*', opts));
});

test('globRegExp and globClass never throw on random glob words (fuzz)', () => {
  const alphabet = ['[', ']', '!', '^', '-', '\\', '*', '?', '{', '}', ',', '.', '/', 'a', 'z', 'e', 'n', 'v', '~', '$',
    '(', ')', '|', '+'];
  let seed = 0x2f6b;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const opts = { cwd: os.tmpdir(), home: os.tmpdir(), env: {} };
  for (let t = 0; t < 3000; t++) {
    let w = '';
    const len = 1 + rnd(12);
    for (let k = 0; k < len; k++) w += alphabet[rnd(alphabet.length)];
    if (!/[*?[\]{}]/.test(w)) w += '[';
    assert.doesNotThrow(() => policy.globRegExp(w), w);
    assert.doesNotThrow(() => policy.globClass(w, opts), w);
  }
});
