'use strict';

// Round trip: strings made with a fixed random seed are quoted by shQuote()
// and printed back by /bin/sh. The output must have the same bytes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { shQuote } = require('../lib/shell-quote');

const SKIP = process.platform === 'win32' ? 'needs /bin/sh' : false;

// Small seeded generator (mulberry32), so every run sees the same strings.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Characters a shell or a quoting routine tends to trip over.
const TRICKY = [
  "'", '"', '\\', '$', '`', '!', '*', '?', '~', '#', '%', '&', ';', '|', '<', '>',
  '(', ')', '{', '}', '[', ']', ' ', '\t', '\n', '\r', '‘', '’', '‚', '‛',
  '“', 'é', '中', '\u{1F600}', '$(echo x)', '${HOME}', '\\n', "'\"'\"'",
];
const PLAIN = 'abcxyzABCXYZ0123456789._-/=:,+@';

function generate(count, seed) {
  const next = rng(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const len = Math.floor(next() * 24);
    let s = '';
    for (let j = 0; j < len; j++) {
      s += next() < 0.5 ? TRICKY[Math.floor(next() * TRICKY.length)] : PLAIN[Math.floor(next() * PLAIN.length)];
    }
    out.push(s);
  }
  return out;
}

function echoBack(s) {
  const r = spawnSync('/bin/sh', ['-c', 'printf %s ' + shQuote(s)], { encoding: 'buffer' });
  assert.equal(r.status, 0, 'sh failed for ' + JSON.stringify(s) + ': ' + r.stderr);
  return r.stdout;
}

test('the generated strings are the same on every run', { skip: SKIP }, () => {
  const a = generate(200, 1728);
  assert.equal(a.length, 200);
  assert.deepEqual(generate(200, 1728), a);
  assert.ok(a.some((s) => s.includes("'")) && a.some((s) => s.includes('\\')) && a.some((s) => s.includes('\n')));
});

test('200 generated strings quoted by shQuote() are echoed back by /bin/sh unchanged', { skip: SKIP }, () => {
  for (const s of generate(200, 1728)) {
    assert.ok(echoBack(s).equals(Buffer.from(s, 'utf8')), 'round trip failed for ' + JSON.stringify(s));
  }
});

test('the empty string and a lone quote round trip', { skip: SKIP }, () => {
  for (const s of ['', "'", '\\', "''", '’']) {
    assert.ok(echoBack(s).equals(Buffer.from(s, 'utf8')), JSON.stringify(s));
  }
});
