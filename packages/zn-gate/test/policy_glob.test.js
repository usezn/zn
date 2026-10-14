'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('../lib/hooks/policy');

// An empty home and project folder, so globClass reads nothing else from the disk.
function emptyOpts(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-glob-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { cwd: dir, home: dir, env: {} };
}

test('globRegExp compiles any bracket expression', () => {
  const globs = ['[z-a]*', '[[:alpha:]', '[[:', '[a\\]', '[\\', 'x[]y', '[!]', '[^]x', '[]]', '[a-]', '[-a]', '[[:alpha:]]',
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
  assert.ok(m('a[^]b', 'a[^]b'), 'an unclosed "[" is a literal character');
  assert.ok(m('a[]]b', 'a]b'), 'a leading "]" is a member');
  assert.ok(m('a[!]]b', 'axb') && !m('a[!]]b', 'a]b'));
  assert.ok(m('id_[[:alpha:]]sa', 'id_rsa') && !m('id_[[:digit:]]sa', 'id_rsa'));
  assert.ok(m('a[[:nosuch:]]b', 'axb'), 'an unknown class matches any character but "/"');
  assert.ok(m('[.]env', '.env'));
  assert.ok(!m('[.]env', 'xenv'));
});

test('a backwards range in a path no longer breaks the policy', (t) => {
  const opts = emptyOpts(t);
  assert.doesNotThrow(() => policy.globClass('~/.ssh/[z-a]*', opts));
  assert.doesNotThrow(() => policy.globClass('./[a\\]*', opts));
});

test('bracket expressions read as the shell reads them still name protected files', (t) => {
  const opts = emptyOpts(t);
  for (const w of ['.e[!]]v', '.e[]n]v', '.e[^]]v', '.en[[:alpha:]]', '~/.netr[]c]', '~/.aws/c[]r]edentials',
    '~/.ssh/id_[[:alpha:]]sa', '~/.ssh/id_[rd]sa', '[.]env', '.en[v]']) {
    assert.ok(policy.globClass(w, opts), w);
  }
});

test('globRegExp and globClass never throw on random glob words (fuzz)', (t) => {
  const alphabet = ['[', ']', '!', '^', '-', '\\', '*', '?', '{', '}', ',', '.', '/', 'a', 'z', 'e', 'n', 'v', '~', '$',
    '(', ')', '|', '+'];
  let seed = 0x2f6b;
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return (seed >>> 8) % n; };
  const opts = emptyOpts(t);
  const seen = new Set();
  for (let t = 0; t < 3000; t++) {
    let w = '';
    const len = 1 + rnd(12);
    for (let k = 0; k < len; k++) { const ch = alphabet[rnd(alphabet.length)]; seen.add(ch); w += ch; }
    if (!/[*?[\]{}]/.test(w)) w += '[';
    assert.doesNotThrow(() => policy.globRegExp(w), w);
    assert.doesNotThrow(() => policy.globClass(w, opts), w);
  }
  assert.strictEqual(seen.size, alphabet.length, 'the generator reaches every symbol');
});
