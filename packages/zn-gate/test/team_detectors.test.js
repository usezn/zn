'use strict';
/*
 * Custom secret formats from a zn Team policy: unsafe patterns are refused,
 * matches are redacted by the scrubber like built-in ones, and a slow
 * pattern cannot hang the hook.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { tempDir } = require('./helpers/tmp');
const detectors = require('../lib/team/detectors');
const engine = require('../lib/scrub/engine');
const policy = require('../lib/team/policy');
const { detectorsOf } = require('../lib/team/effective');

const ACME = 'ACME-' + 'K7Q2ZP4M9XW3LB8RT5VN6YC1';

test('unsafe or useless patterns are refused', () => {
  for (const p of ['(a+)+$', '(\\w*)*x', '(a|ab)*c', '(x|xy){2,4}z', '(a)\\1bc', '(?=abc)abc', '(?<!a)bcd', 'a*b?', '[unclosed', 'abc',
    'ab+cd', 'ab{2,}cd', 'x[a-z]{0,100}y', 'a[a-z]{0,9}b[a-z]{0,9}c[a-z]{0,9}d', 'k_[0-9]{300}', '[a-z]*[a-z]*1',
    // Accepted by an earlier, regex-based check and still catastrophic: groups with ? or alternatives.
    '(?:[a-z ]?){20}#', '((a|aa)){40}x', '(?:a?){64}x', '((?:a{1,2})){24}x', 'abc?d', 'a|bcd']) {
    assert.ok(detectors.checkPattern(p), p);
  }
  for (const p of ['^ACME-[A-Z0-9]{24}$', 'ACME-[A-Z0-9]{24}', 'ghp_[A-Za-z0-9]{36}', 'tok_[*+]{8}', 'id-\\d{6}-x', 'xox[bp]-[0-9]{10,13}-[A-Za-z0-9]{24}']) {
    assert.strictEqual(detectors.checkPattern(p), null, p);
  }
  const compiled = detectors.compile([
    { id: 'acme', pattern: 'ACME-[A-Z0-9]{24}', type: 'ACME_TOKEN' },
    { id: 'bad', pattern: '(a+)+$', type: 'BAD' },
    { id: 'BadId', pattern: 'ACME-[A-Z0-9]{24}', type: 'X' },
  ]);
  assert.deepStrictEqual(compiled.map((d) => d.id), ['acme']);
});

test('custom matches are found per line, also on long lines', () => {
  const c = detectors.compile([{ id: 'acme', pattern: 'ACME-[A-Z0-9]{24}', type: 'ACME_TOKEN' }]);
  const text = 'first line\ntoken=' + ACME + '\n' + 'x'.repeat(10000) + ' ' + ACME;
  const spans = detectors.find(text, c);
  assert.strictEqual(spans.length, 2);
  for (const s of spans) assert.strictEqual(text.slice(s.start, s.end), ACME);
});

test('the scrubber redacts an organization format it would not know otherwise', async () => {
  const c = detectors.compile([{ id: 'acme', pattern: 'ACME-[A-Z0-9]{24}', type: 'ACME_TOKEN' }]);
  const text = 'export INTERNAL=' + ACME;
  const without = engine.scan(text, { exact: false });
  assert.ok(!without.some((s) => text.slice(s.start, s.end) === ACME));
  const res = await engine.tokenize(text, { exact: false, vault: null, destination: 'assistant', detectors: c });
  assert.ok(!res.text.includes(ACME), res.text);
  assert.match(res.text, /__ZN_REDACTED_ACME_TOKEN__|__ZN_ACME_TOKEN_\d+__/);
});

test('patterns that could run for a long time never get to run', () => {
  // Heavy backtracking needs unbounded or many variable repetitions, or a
  // repeated group with alternatives: refused before anything runs.
  for (const p of ['[a-z]*[a-z]*[a-z]*[a-z]*1', '(a|aa){1,30}b', 'a{0,64}a{0,64}a{0,64}b', '(?:[a-z ]?){26}#',
    // Polynomial: two variable repetitions, or one with a long fixed tail (13-48 s on one line before).
    '[a-z]{0,64}[a-z]{0,64}1', '.{192,256}.{192,256}.{256}.{256}x', 'a{0,64}a{0,64}.{256}.{256}.{256}x',
    '.{192,256}' + '.{256}'.repeat(38) + 'x', 'a{0,64}' + '.{256}'.repeat(10) + 'x', '.{256}.{256}.{256}.{256}.{256}.{256}.{256}.{256}.{256}.{256}.{256}.{256}.{256}.{256}.{256}.{256}x']) {
    assert.ok(detectors.checkPattern(p), p);
  }
  // The worst accepted shape stays fast on hostile input: one window costs
  // at most (span + 1) x longest match steps per start position.
  assert.strictEqual(detectors.checkPattern('.{0,62}x'), null);
  const c = detectors.compile([{ id: 'worst', pattern: '.{0,62}x', type: 'WORST' }]);
  const text = ('a'.repeat(4000) + '\n').repeat(10);
  const t0 = Date.now();
  detectors.find(text, c);
  assert.ok(Date.now() - t0 < 1000, 'took ' + (Date.now() - t0) + ' ms');
});

test('all custom detectors together stop after their time budget for one call', () => {
  detectors.resetBudget();
  const many = Array.from({ length: 50 }, (_, i) => ({ id: 'd' + i, pattern: '.{0,62}x', type: 'WORST' }));
  const c = detectors.compile(many);
  assert.strictEqual(c.length, 50);
  const text = ('a'.repeat(4000) + '\n').repeat(50);
  const t0 = Date.now();
  detectors.find(text, c);
  assert.ok(Date.now() - t0 < detectors.CALL_BUDGET_MS + 1000, 'took ' + (Date.now() - t0) + ' ms');
});

test('detectors come from the verified policy cache only', (t) => {
  const home = tempDir(t, 'zn-team-det-');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const key = der.subarray(der.length - 32).toString('base64url');
  const pin = { alg: 'Ed25519', kid: policy.kidOf(key), key };
  policy.writeTeam({ org: 'org_TestOrg12345678', api_base: 'https://api.usezn.com', install_id: crypto.randomUUID(), policy_public_key: pin }, { home });
  const now = Date.now();
  const p = { org: 'org_TestOrg12345678', version: 1, issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 86400000).toISOString(), rules: [],
    detectors: [{ id: 'acme', pattern: 'ACME-[A-Z0-9]{24}', type: 'ACME_TOKEN' }] };
  const sig = crypto.sign(null, Buffer.from(policy.canonicalJson(p), 'utf8'), privateKey).toString('base64url');
  assert.strictEqual(policy.accept({ policy: p, signature: { alg: 'Ed25519', kid: pin.kid, sig } }, null, { home }).ok, true);
  assert.strictEqual(detectorsOf(policy.state({ home })).length, 1);
  // Edited cache: no detectors (and no crash).
  const file = policy.paths({ home }).policyFile;
  const c = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  c.envelope.policy.detectors[0].pattern = '(a+)+$';
  require('fs').writeFileSync(file, JSON.stringify(c));
  assert.strictEqual(detectorsOf(policy.state({ home })).length, 0);
});

test('across many scans in one process, custom detectors stop after the process budget', () => {
  detectors.resetBudget();
  // Tuned to stay under the per-window guard, so no detector switches itself off.
  const many = Array.from({ length: 50 }, (_, i) => ({ id: 'p' + i, pattern: '.{0,15}.{240}x', type: 'COSTLY' }));
  const c = detectors.compile(many);
  assert.strictEqual(c.length, 50);
  const field = 'a'.repeat(1000);
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) detectors.find(field, c);
  const took = Date.now() - t0;
  assert.ok(took < detectors.PROCESS_BUDGET_MS + 500, 'took ' + took + ' ms');
  assert.ok(c.every((d) => d.off), 'all detectors are off once the budget is spent');
  detectors.resetBudget();
});
