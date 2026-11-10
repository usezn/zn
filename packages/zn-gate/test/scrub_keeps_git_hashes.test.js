'use strict';
/**
 * Git commit hashes in normal text are not secrets: a full 40-hex SHA-1 and
 * abbreviated hashes (7 to 12 hex digits) stay intact, while a fake secret in
 * the same text is still masked. Fake values only.
 */
const assert = require('assert');
const { test, run } = require('./_harness');
const E = require('../lib/scrub/engine');

// AWS documentation example key; allowlisted by .gitleaks.toml.
const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE';
const FULL = '3f2c9a1e8b7d6c5f4a3b2c1d0e9f8a7b6c5d4e3f';
const SHORTS = ['3f2c9a1', '3f2c9a1b8d7e'];

test('commit hashes in prose are not secret spans', async () => {
  for (const hash of [FULL].concat(SHORTS)) {
    for (const text of [
      'fixed in commit ' + hash + '\n',
      'merged ' + hash + ' into next\n',
      'revert of ' + hash + ': see the CHANGELOG\n',
    ]) {
      const spans = await E.scanAsync(text, {});
      assert.deepStrictEqual(spans.map((s) => s.type + ':' + text.slice(s.start, s.end)), [], text);
    }
  }
});

test('tokenize keeps short and full hashes and masks a fake key in the same text', async () => {
  for (const short of SHORTS) {
    const text = 'fixed in commit ' + short + ' (full ' + FULL + ')\nAWS key: ' + FAKE_KEY + '\n';
    const spans = await E.scanAsync(text, {});
    assert.deepStrictEqual(spans.map((s) => text.slice(s.start, s.end)), [FAKE_KEY], text);
    const out = await E.tokenize(text, {});
    assert.strictEqual(out.text, 'fixed in commit ' + short + ' (full ' + FULL + ')\nAWS key: __ZN_REDACTED_AWS_KEY__\n');
  }
});

if (require.main === module) run('scrub keeps git hashes');
