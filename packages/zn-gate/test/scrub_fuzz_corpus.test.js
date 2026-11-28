'use strict';
/**
 * The Node.js half of the scrubber fuzz corpus (test/fixtures/scrubber_fuzz_corpus.json), made by
 * packages/zn-gate-py/tests/fuzz_scrubber_at_scale.py: fake provider keys split by newlines, tabs, quotes,
 * Unicode separators and escapes, inside JSON, YAML, shell and markdown text. Each case wants "no readable
 * run of 8 or more characters of the key body"; node_remnant records what is still wrong today. A case
 * whose state changes fails here, in both directions, so a fix must flip the field and the list cannot
 * go stale. Parity with Python is checked by the Python test (tests/test_scrubber_fuzz.py).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { redactSecrets } = require('../lib/rules');

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'scrubber_fuzz_corpus.json'), 'utf8'));
const STRIP = new RegExp('\\\\[nrt]|[\\s"\'+\\\\`\\u2028\\u2029\\u00a0\\u200b\\u200c\\u200d\\ufeff]', 'g');

function remnant(secret, out) {
  const flat = out.replace(STRIP, '');
  for (let i = 0; i + 8 <= secret.length; i++) {
    if (flat.includes(secret.slice(i, i + 8))) return true;
  }
  return false;
}

test('the corpus has the failure classes', () => {
  assert.ok(corpus.length > 100);
  const classes = new Set(corpus.map((c) => c.class));
  for (const k of ['remnant_newline', 'remnant_unicode_space', 'remnant_quote_split', 'remnant_escaped_break']) {
    assert.ok(classes.has(k), k);
  }
});

for (const c of corpus) {
  test(`fuzz corpus ${c.id}`, () => {
    const out = redactSecrets(c.text_parts.join('')).sanitized;
    assert.equal(remnant(c.secret_parts.join(''), out), c.node_remnant, 'node state changed: update the corpus');
  });
}

// A wrapped key whose last line is lower-case is redacted whole. Python has the same tests (tests/test_scrubber_fuzz.py).
test('the lower-case last line of a wrapped key is redacted with the key', () => {
  const out = redactSecrets('token sk-proj-FAKEABCDEFGHJKLMNPQRSTUVWXYZABCDEFGHJK\nqwertyuiop.').sanitized;
  assert.ok(!out.includes('qwertyuiop'), out);
  assert.ok(!out.includes('FAKEABCD'), out);
});

test('a lower-case last line is kept with a key that is not complete without it', () => {
  // The first line alone is too short to be a token, so the line break is not a cut point even though a dash follows.
  const out = redactSecrets('token ghp_FAKE0123456789ABCDEFabcdef0123\nqwertyuiop-x done').sanitized;
  assert.ok(!out.includes('qwertyuiop'), out);
  assert.ok(!out.includes('FAKE0123'), out);
});
