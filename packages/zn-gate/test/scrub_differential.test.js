'use strict';

// Differential check of the secret redaction against the Python package. The corpus holds generated texts
// (fake keys assigned, JSON-escaped, in a URL query or a header, split by empty quote pairs, written with
// percent-encoding or broken by an invisible character) and the text each function returns for them.
// tests/test_scrub_differential.py in the Python package reads the same file, so the two engines
// must return the same text for every one of them. Regenerate the file with
// `node test/helpers/scrub_corpus.js --write` after a change that moves the output on purpose.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { redactSecrets, redactScanSecrets } = require('../lib/rules');
const { generate, decodeCases, SEED, COUNT, FILE } = require('./helpers/scrub_corpus');

const corpus = JSON.parse(fs.readFileSync(FILE, 'utf8'));
// The file stores each string base64-encoded (no key-shaped text in the repository).
corpus.cases = decodeCases(corpus.cases);

test('the corpus is what the seeded generator makes', () => {
  assert.equal(corpus.seed, SEED);
  assert.equal(corpus.count, COUNT);
  assert.equal(corpus.cases.length, COUNT);
  const inputs = generate(COUNT, SEED);
  for (let i = 0; i < COUNT; i++) assert.equal(corpus.cases[i][0], inputs[i], 'input ' + i);
});

test('redactSecrets and redactScanSecrets return the text of the corpus', () => {
  const bad = [];
  let changed = 0;
  for (const [input, secrets, scanned] of corpus.cases) {
    const want = secrets === null ? input : secrets;
    const wantScan = scanned === null ? want : scanned;
    if (want !== input) changed++;
    const got = redactSecrets(input).sanitized;
    const gotScan = redactScanSecrets(input).sanitized;
    if (got !== want) bad.push(['redactSecrets', input, want, got]);
    if (gotScan !== wantScan) bad.push(['redactScanSecrets', input, wantScan, gotScan]);
  }
  assert.equal(bad.length, 0, bad.length + ' differ, first: ' + JSON.stringify(bad[0]));
  // Most texts hold a secret that is redacted; the rest are placeholders, short values and other names.
  assert.ok(changed > COUNT / 2, changed + ' texts changed');
});
