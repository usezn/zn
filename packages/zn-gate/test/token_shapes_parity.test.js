'use strict';

// Fake token shapes shared with the Python package: test/fixtures/token_shapes.json holds about fifty texts
// (GitHub, AWS, Slack, Stripe test keys, JWT, private keys, and near misses), each with the secret type it
// must give or "none". The Python package reads the same file (packages/zn-gate-py/tests/
// test_token_shapes_parity.py), so the two stay on the same rule for every length bound and prefix. Values are
// built here from segments and are never real credentials.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { redactSecrets } = require('../lib/rules');
const engine = require('../lib/scrub/engine');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'token_shapes.json'), 'utf8'));
const GENERIC = new Set(['env_credential', 'prefixed_credential', 'credential_default', 'credential_assignment', 'cli_credential_flag']);
const ALIAS = { AWS_ACCESS_KEY: 'AWS_KEY', AWS_KEY_ID: 'AWS_KEY', JWT_TOKEN: 'JWT', AWS_SECRET_KEY: 'AWS_SECRET', GITHUB_PAT: 'GITHUB_TOKEN' };

function expand(entry) {
  return entry.segments.map((s) => {
    if (typeof s === 'string') return s;
    if (s.rep) return s.rep[0].repeat(s.rep[1]);
    const [n, off] = s.alpha;
    return Array.from({ length: n }, (_, i) => fixture.alphabet[(off + i) % fixture.alphabet.length]).join('');
  }).join('');
}

const canon = (name) => ALIAS[name.toUpperCase()] || name.toUpperCase();
const expected = (entry) => (entry.expect === 'none' ? [] : [entry.expect]);

test('the fixture has the families and the near misses', () => {
  assert.ok(fixture.entries.length >= 40);
  const ids = new Set(fixture.entries.map((e) => e.id));
  assert.equal(ids.size, fixture.entries.length, 'ids are unique');
  const types = new Set(fixture.entries.map((e) => e.expect));
  for (const t of ['GITHUB_TOKEN', 'AWS_KEY', 'AWS_SECRET', 'SLACK_TOKEN', 'STRIPE_KEY', 'JWT', 'PRIVATE_KEY', 'none']) assert.ok(types.has(t), t);
});

for (const entry of fixture.entries) {
  test(`redactSecrets: ${entry.id}`, () => {
    const text = expand(entry);
    const got = [...new Set(redactSecrets(text).detections
      .map((d) => d.rule.split(':')[1])
      .filter((n) => !GENERIC.has(n))
      .map(canon))].sort();
    assert.deepEqual(got, expected(entry), entry.note || '');
  });

  test(`scrubber: ${entry.id}`, () => {
    // The scrubber (secret layer of the pattern engine) finds the type or nothing; it never finds another.
    // A low-entropy body is a case where it may find less than the shared rules do.
    const text = expand(entry);
    const got = [...new Set(engine.scan(text, { exact: false, pii: false })
      .filter((s) => s.source === 'pattern' && s.type !== 'SECRET')
      .map((s) => canon(s.type)))];
    for (const t of got) assert.ok(expected(entry).includes(t), `unexpected ${t}`);
  });
}
