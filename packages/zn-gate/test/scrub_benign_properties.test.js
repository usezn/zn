'use strict';
/**
 * Property-style false-positive tests for the secret scrubber.
 *
 * Every family below is a kind of text that looks like a secret to a naive
 * detector (hashes, UUIDs, lockfile integrity strings, image bytes, ...) but
 * is not one. Samples are generated at run time from a seeded PRNG
 * (mulberry32, no dependency): the same seed gives the same samples, nothing
 * is stored literally, and nothing here is a credential.
 *
 * Each family produces thousands of samples, wrapped in a few realistic
 * contexts (log line, JSON, YAML, shell, markdown). `scan` (patterns + PII,
 * the engine that hooks and `zn-gate scan` use) must return no span for them.
 *
 * Choices the engine makes on purpose are not hidden: see the "known cases"
 * tests at the end.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./_harness');
const E = require('../lib/scrub/engine');
const P = require('../lib/scrub/patterns');
const { generateAll, mulberry32 } = require('./fixtures/fake_secrets');

const N = 2500; // samples per family
const rnd = mulberry32(20261017);
const ri = (n) => Math.floor(rnd() * n);
const pick = (chars, n) => { let s = ''; for (let i = 0; i < n; i++) s += chars[ri(chars.length)]; return s; };
const one = (arr) => arr[ri(arr.length)];

const HEX = '0123456789abcdef';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const B64 = ALNUM + '+/';
const B64URL = ALNUM + '-_';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = '0123456789';
const hex = (n) => pick(HEX, n);
const b64Bytes = (nBytes) => {
  // base64 of nBytes random bytes, padded like the real thing
  const chars = Math.ceil((nBytes * 4) / 3);
  return pick(B64, chars) + '='.repeat((4 - (chars % 4)) % 4);
};

/* ---------------- generators: one benign value per call ---------------- */

const uuidWith = (version) => {
  const h = hex(32);
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + version + h.slice(13, 16) + '-' + one('89ab') + h.slice(17, 20) + '-' + h.slice(20, 32);
};
const uuidV7 = () => {
  const ms = (1700000000000 + ri(100000000000)).toString(16).padStart(12, '0');
  const h = hex(18);
  return ms.slice(0, 8) + '-' + ms.slice(8, 12) + '-7' + h.slice(0, 3) + '-' + one('89ab') + h.slice(3, 6) + '-' + h.slice(6, 18);
};
const WORDS = ['get', 'set', 'init', 'make', 'render', 'handle', 'parse', 'Node', 'View', 'State', 'Props', 'Chunk'];
const ident = () => one(WORDS) + one(WORDS) + one(WORDS) + (rnd() < 0.5 ? ri(100) : '');
const acct = () => pick(DIGITS, 12);

const FAMILIES = {
  'git sha1 (full and short)': () => (rnd() < 0.7 ? hex(40) : hex(7 + ri(6))),
  'sha256 hex': () => hex(64),
  'sha512 hex': () => hex(128),
  'md5 hex': () => hex(32),
  'uuid v1': () => uuidWith('1'),
  'uuid v4': () => uuidWith('4'),
  'uuid v7': uuidV7,
  'png data uri': () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA' + b64Bytes(60 + ri(900)),
  'jpeg, gif, webp, svg data uri': () => one([
    () => 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD' + b64Bytes(60 + ri(900)),
    () => 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' + b64Bytes(20 + ri(300)),
    () => 'data:image/webp;base64,UklGR' + b64Bytes(60 + ri(600)),
    () => 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg' + b64Bytes(30 + ri(300)),
  ])(),
  'npm, yarn, pnpm integrity': () => one([
    () => 'sha512-' + b64Bytes(64),
    () => 'sha1-' + b64Bytes(20),
    () => 'sha384-' + b64Bytes(48),
  ])(),
  'go.sum and go.mod': () => one([
    () => 'h1:' + b64Bytes(32),
    () => 'v0.0.0-' + (20100101000000 + ri(160000000000)) + '-' + hex(12),
    () => 'github.com/example/mod v1.' + ri(40) + '.' + ri(20) + ' h1:' + b64Bytes(32),
  ])(),
  'python hashes (pip --hash, poetry)': () => one([
    () => '--hash=sha256:' + hex(64),
    () => 'sha256:' + hex(64),
    () => 'md5=' + hex(32),
  ])(),
  'cargo lock checksum': () => hex(64),
  'minified js and css identifiers': () => one([
    () => '_0x' + hex(4 + ri(4)),
    () => ident(),
    () => 'css-' + pick('0123456789abcdefghijklmnopqrstuvwxyz', 6 + ri(4)),
    () => 'chunk-' + hex(8) + '.' + hex(8) + '.js',
    () => 'main.' + hex(8) + '.chunk.js',
    () => pick(ALNUM, 1 + ri(2)) + '.' + pick(ALNUM, 1 + ri(2)) + '=function(' + pick('abcdefgh', 1) + ',' + pick('abcdefgh', 1) + '){return ' + pick('abcdefgh', 1) + '}',
    () => '.' + ident() + '__' + ident() + '--' + ident(),
  ])(),
  'base32 totp-like': () => pick(B32, 16 + 16 * ri(2)),
  'version strings': () => one([
    () => ri(30) + '.' + ri(100) + '.' + ri(100),
    () => 'v' + ri(30) + '.' + ri(100) + '.' + ri(100) + '-rc.' + ri(20) + '+build.' + ri(9999),
    () => ri(30) + '.' + ri(100) + '.' + ri(100) + '.' + ri(9999),
    () => '3.' + (8 + ri(8)) + '.' + ri(20) + 'a' + ri(5),
    () => '20' + (20 + ri(7)) + '.' + (1 + ri(12)) + '.' + (1 + ri(28)),
  ])(),
  'ipv6 addresses': () => one([
    () => Array.from({ length: 8 }, () => hex(1 + ri(4))).join(':'),
    () => '2001:db8:' + hex(1 + ri(4)) + '::' + hex(1 + ri(4)),
    () => 'fe80::' + hex(4) + ':' + hex(4) + ':' + hex(4) + ':' + hex(4) + '%eth' + ri(3),
    () => '[2001:db8::' + hex(1 + ri(3)) + ']:' + (1024 + ri(60000)),
    () => '::1',
    () => '::ffff:192.0.2.' + ri(256),
  ])(),
  'aws arns without keys': () => one([
    () => 'arn:aws:iam::' + acct() + ':role/' + ident(),
    () => 'arn:aws:s3:::example-bucket-' + ri(1000) + '/' + ident() + '/*',
    () => 'arn:aws:lambda:us-east-1:' + acct() + ':function:' + ident() + ':' + ri(100),
    () => 'arn:aws:kms:eu-west-1:' + acct() + ':key/' + uuidWith('4'),
    () => 'arn:aws:secretsmanager:us-east-1:' + acct() + ':secret:app/' + ident() + '-' + pick(ALNUM, 6),
    () => 'arn:aws:sagemaker:us-east-2:' + acct() + ':training-job/' + ident() + '-' + ri(99999),
  ])(),
  'docker image digests': () => one([
    () => 'sha256:' + hex(64),
    () => 'docker.io/library/node:24@sha256:' + hex(64),
    () => 'ghcr.io/example/app@sha256:' + hex(64),
    () => 'public.ecr.aws/lambda/nodejs:20-x86_64@sha256:' + hex(64),
  ])(),
  'github run and job ids': () => one([
    () => 'https://github.com/example/repo/actions/runs/' + (1000000000 + ri(9000000000)),
    () => 'https://github.com/example/repo/actions/runs/' + (1000000000 + ri(9000000000)) + '/job/' + (10000000000 + ri(90000000000)),
    () => String(1000000000 + ri(9000000000)),
    () => String(10000000000 + ri(90000000000)),
  ])(),
  'placeholders': () => one([
    'your-api-key-here', 'YOUR_API_KEY', 'your_token_here', '<TOKEN>', '<your-api-key>', '${API_KEY}', '$TOKEN',
    'xxxxxxxx', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', '********', '****************', 'changeme', 'REDACTED', '<redacted>',
    'process.env.API_KEY', 'os.environ["API_KEY"]', 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'AKIAXXXXXXXXXXXXXXXX', 'xoxb-xxxxxxxxxxx-xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxx',
    '0000000000000000000000000000000000000000', '00000000-0000-0000-0000-000000000000', 'abcdefghijklmnopqrstuvwxyz',
  ]),
};

/* Contexts. None names a secret-ish key (password, token, secret, key): a
 * hash next to such a name is a different question, covered by the exact and
 * structured tests. The placeholder family uses secret-ish contexts. */
const CONTEXTS = [
  (v) => v,
  (v) => 'commit ' + v + '\nAuthor: someone',
  (v) => '{"id": "' + v + '", "name": "example"}',
  (v) => 'id: ' + v + '\nname: example\n',
  (v) => 'echo ' + v + ' | tee out.txt',
  (v) => 'see `' + v + '` in the log',
  (v) => '"integrity": "' + v + '",',
  (v) => 'checksum = "' + v + '"',
  (v) => '<img src="' + v + '" alt="x">',
  (v) => 'background: url(' + v + ') no-repeat;',
  (v) => '[' + v.slice(0, 12) + '](https://example.com/x)',
  (v) => '"sha": "' + v + '"',
  (v) => 'digest: ' + v,
  (v) => 'hash = ' + v,
  (v) => 'etag: "' + v + '"',
  (v) => 'resolved: "https://registry.example.com/pkg/-/pkg-1.0.0.tgz#' + v + '"',
];
const SECRETISH_CONTEXTS = [
  (v) => 'API_KEY=' + v,
  (v) => 'Authorization: Bearer ' + v,
  (v) => 'export OPENAI_API_KEY="' + v + '"',
  (v) => 'token: ' + v,
  (v) => '"password": "' + v + '"',
  (v) => 'const apiKey = "' + v + '";',
  (v) => 'Replace ' + v + ' with your key.',
];

function hits(text) {
  return E.scan(text, { exactFiles: false }).map((s) => ({ type: s.type, text: text.slice(s.start, s.end) }));
}

for (const [family, gen] of Object.entries(FAMILIES)) {
  test('no span on benign family: ' + family + ' (' + N + ' samples)', () => {
    const ctxs = family === 'placeholders' ? CONTEXTS.slice(0, 1).concat(SECRETISH_CONTEXTS) : CONTEXTS;
    const bad = [];
    for (let i = 0; i < N; i++) {
      const text = one(ctxs)(gen());
      const h = hits(text);
      if (h.length) bad.push(h[0].type + ' <- ' + text.slice(0, 90).replace(/\n/g, '\\n'));
      if (bad.length >= 5) break;
    }
    assert.strictEqual(bad.length, 0, family + ' fired:\n  ' + bad.join('\n  '));
  });
}

/* ---------------- fixed corpus: lockfiles and docs of this repo ---------------- */

test('real lockfiles and docs of the repository give no span', () => {
  const root = path.join(__dirname, '..', '..', '..');
  const files = [
    path.join(__dirname, '..', 'package-lock.json'),
    path.join(root, 'plugins', 'zn-gate', 'package-lock.json'),
    path.join(root, 'Cargo.lock'),
    path.join(root, 'CHANGELOG.md'),
    path.join(root, 'packages', 'zn-gate', 'README.md'),
  ].filter((f) => fs.existsSync(f));
  assert.ok(files.length >= 1, 'no corpus file found');
  const bad = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 40) {
      const chunk = lines.slice(i, i + 40).join('\n');
      // Docs name contact emails on purpose: only secret types count here.
      // The docs also show AWS's documentation example key on purpose; it is redacted now.
      for (const h of hits(chunk)) if (!P.PII_TYPES.includes(h.type) && !/^AKIAIOSFODNN7EXAMPLE$/.test(h.text)) bad.push(path.basename(f) + ':' + (i + 1) + ' ' + h.type);
    }
  }
  assert.strictEqual(bad.length, 0, 'fired on real files:\n  ' + bad.slice(0, 5).join('\n  '));
});

/* ---------------- the fix keeps real fakes caught ---------------- */

test('masks are placeholders, real-looking values with filler or runs stay detected', () => {
  const types = (t) => hits(t).map((h) => h.type);
  const tok = (n) => pick(ALNUM, n);
  // masks: allowed
  assert.strictEqual(hits('sk-ant-api03-' + 'x'.repeat(40)).length, 0);
  assert.strictEqual(hits('Authorization: Bearer xoxb-' + 'x'.repeat(11) + '-' + 'x'.repeat(12) + '-' + 'x'.repeat(8)).length, 0);
  // reviewer cases (PR 283): they must stay detected
  const real = tok(40);
  const ant = 'sk-ant-api03-' + pick(B64URL, 93);
  assert.ok(types('Authorization: Bearer ' + real + 'x'.repeat(40)).includes('BEARER_TOKEN'), 'bearer padded with x');
  assert.ok(types('Authorization: Bearer ' + real.split('').join('x') + 'x').includes('BEARER_TOKEN'), 'bearer interleaved');
  assert.ok(types(ant + 'x'.repeat(100)).includes('ANTHROPIC_KEY'), 'anthropic padded');
  assert.ok(types('sk-ant-api03-' + pick(B64URL, 93).split('').join('-') + '-').includes('ANTHROPIC_KEY'), 'anthropic interleaved');
  assert.ok(types('Authorization: Bearer ' + 'A'.repeat(22) + tok(18)).includes('BEARER_TOKEN'), 'bearer with A run');
  assert.ok(types('Authorization: Bearer aaaaaaaa' + tok(12)).includes('BEARER_TOKEN'), 'bearer with a run');
  assert.ok(types('postgres://app:' + tok(20) + '@db.example.com/x').length > 0, 'url password');
  assert.ok(types('postgres://app:Zq9!' + '1'.repeat(14) + '@db.example.com/x').length > 0, 'url password with run');
  // the fakes of the leak bench and random keys
  const { secrets } = generateAll(1337005, { perType: 25 });
  for (const s of secrets) {
    const found = hits('value: ' + s.value + '\n');
    assert.ok(found.length > 0 || s.type === 'aws_secret_access_key', s.type + ' lost: ' + s.value.slice(0, 12));
  }
  for (let i = 0; i < 300; i++) {
    assert.ok(types('k sk-ant-api03-' + pick(B64URL, 93)).includes('ANTHROPIC_KEY'), 'random anthropic key missed');
    assert.ok(types('Authorization: Bearer ' + tok(40)).includes('BEARER_TOKEN'), 'random bearer missed');
  }
});

/* ---------------- known cases: deliberate choices ---------------- */

test('known case: the jwt.io sample shape is a JWT and is caught', () => {
  // A JWT in docs is the same format as a real one and cannot be told apart
  // from it by shape; the engine keeps catching it. Built at run time.
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = enc({ alg: 'HS256', typ: 'JWT' }) + '.' + enc({ sub: '1234567890', name: 'John Doe', iat: 1516239022 }) + '.' + pick(B64URL, 43);
  assert.ok(hits('Example token: ' + tok).some((h) => h.type === 'JWT'));
});

test('known case: Stripe publishable keys (pk_test_, pk_live_) are not secrets', () => {
  // Publishable keys ship in front-end code by design; only sk_/rk_ keys are
  // patterns. Built at run time.
  for (let i = 0; i < 50; i++) {
    for (const pre of ['pk_test_', 'pk_live_']) assert.strictEqual(hits('const stripe = Stripe("' + pre + pick(ALNUM, 24 + ri(40)) + '")').length, 0);
  }
});

test('the benign families run in linear time', () => {
  const t0 = Date.now();
  const big = ('commit ' + hex(40) + '\n' + 'sha512-' + b64Bytes(64) + '\n' + uuidWith('4') + '\n').repeat(4000);
  hits(big);
  assert.ok(Date.now() - t0 < 2000, 'scan too slow: ' + (Date.now() - t0) + ' ms');
});

module.exports = { FAMILIES };
if (require.main === module) run('scrub benign properties');
