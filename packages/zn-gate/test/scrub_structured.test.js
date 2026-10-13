'use strict';
/**
 * Pattern layer, structured config: YAML (unquoted), docker-compose
 * (environment map and list), Dockerfile ENV / ARG, `docker run -e`, and
 * hex values under a sensitive key. Every secret value is generated at run
 * time from a seeded PRNG: fake, never real.
 */
const assert = require('assert');
const { test, run } = require('./_harness');
const P = require('../lib/scrub/patterns');
const { mulberry32 } = require('./fixtures/fake_secrets');

const rnd = mulberry32(5150);
const pick = (chars, n) => { let s = ''; for (let i = 0; i < n; i++) s += chars[Math.floor(rnd() * chars.length)]; return s; };
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const ALNUM = UPPER + LOWER + DIGITS;
const HEX = '0123456789abcdef';

/* Random values with a guaranteed shape (no accidental placeholder). */
function password(n) {
  for (;;) {
    const v = pick(ALNUM, n || 20);
    if (/[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v)) return v;
  }
}
function hex(n) {
  for (;;) {
    const v = pick(HEX, n);
    if (/\d/.test(v) && /[a-f]/.test(v) && !/^abcdef/.test(v)) return v;
  }
}

function covers(text, value) {
  const at = text.indexOf(value);
  assert.ok(at >= 0, 'test bug: value not in text');
  return P.findPatterns(text, {}).some((s) => s.start <= at && s.end >= at + value.length);
}

function untouched(text) {
  return P.findPatterns(text, {}).length === 0;
}

/* ---------------- leaks that must be covered ---------------- */

const CONTEXTS = [
  ['yaml unquoted', (v) => 'app:\n  database:\n    host: db.internal\n    password: ' + v + '\n'],
  ['yaml list item', (v) => 'users:\n  - name: deploy\n  - password: ' + v + '\n'],
  ['yaml double-quoted', (v) => 'auth:\n  client_secret: "' + v + '"\n'],
  ['yaml single-quoted', (v) => "auth:\n  apiToken: '" + v + "'\n"],
  ['yaml trailing comment', (v) => 'api_token: ' + v + '   # rotated monthly\n'],
  ['yaml CRLF', (v) => 'db:\r\n  password: ' + v + '\r\n  port: 5432\r\n'],
  ['compose map', (v) => 'services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: ' + v + '\n    ports:\n      - "5432:5432"\n'],
  ['compose list', (v) => 'services:\n  api:\n    environment:\n      - NODE_ENV=production\n      - API_SECRET=' + v + '\n'],
  ['compose list quoted', (v) => 'services:\n  api:\n    environment:\n      - "SESSION_SECRET=' + v + '"\n'],
  ['dockerfile ENV', (v) => 'FROM node:20-alpine\nENV APP_SECRET=' + v + '\nCMD ["node", "server.js"]\n'],
  ['dockerfile ENV space', (v) => 'FROM node:20-alpine\nENV APP_SECRET ' + v + '\n'],
  ['dockerfile ARG', (v) => 'ARG NPM_TOKEN=' + v + '\n'],
  ['dotenv lowercase', (v) => 'db_password=' + v + '\n'],
  ['dotenv with comment', (v) => 'STRIPE_SECRET=' + v + ' # test mode\n'],
  ['docker run -e', (v) => 'docker run -e API_KEY=' + v + ' -p 8080:8080 app:latest\n'],
  ['docker run --env=', (v) => 'docker run --env=DB_PASSWORD=' + v + ' app\n'],
  ['json last field', (v) => '{\n  "name": "svc",\n  "clientSecret": "' + v + '"\n}\n'],
  ['json field with comma', (v) => '{\n  "auth_token": "' + v + '",\n  "region": "eu"\n}\n'],
];

test('random values under a sensitive key are covered in every structured context', () => {
  for (const [label, mk] of CONTEXTS) {
    const v = password(20);
    assert.ok(covers(mk(v), v), label);
  }
});

test('hex values of 32+ digits under a sensitive key are covered', () => {
  for (const [label, mk] of CONTEXTS) {
    for (const n of [32, 40, 64]) {
      const v = hex(n);
      assert.ok(covers(mk(v), v), label + ' hex' + n);
    }
  }
  const upper = hex(64).toUpperCase();
  assert.ok(covers('ENCRYPTION_KEY=' + upper + '\n', upper), 'upper-case hex');
});

test('only the value is a span, typed SECRET', () => {
  const v = password(24);
  const text = 'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: ' + v + '  # local only\n';
  const spans = P.findPatterns(text, {});
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(text.slice(spans[0].start, spans[0].end), v);
  assert.strictEqual(spans[0].type, 'SECRET');
});

test('sensitive key names: camelCase, dashes, dots and suffixes', () => {
  for (const name of ['password', 'db_password', 'POSTGRES_PASSWORD', 'clientSecret', 'client-secret', 'auth.token',
    'apiKey', 'API_KEY', 'secretAccessKey', 'MYSQL_ROOT_PASSWORD', 'DB_PASS', 'SMTP_PWD', 'SENTRY_DSN', 'credentials']) {
    assert.ok(P.sensitiveKey(name), name);
  }
  for (const name of ['key', 'image', 'ports', 'POSTGRES_USER', 'POSTGRES_PASSWORD_FILE', 'secret_name', 'token_endpoint',
    'public_key', 'VAPID_PUBLIC_KEY', 'api_key_header', 'secret_arn', 'KEY_ID', 'revision', 'commit_sha', 'color', 'PWD']) {
    assert.ok(!P.sensitiveKey(name), name);
  }
});

/* ---------------- benign config that must stay intact ---------------- */

const COMMIT = '3f786850e387550fdab836ed7e6dc881de23001b';
const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const UUID = '550e8400-e29b-41d4-a716-446655440000';

test('benign YAML and compose files are untouched', () => {
  for (const t of [
    'services:\n  db:\n    image: postgres:16\n    ports:\n      - "5432:5432"\n    environment:\n      POSTGRES_USER: app\n      POSTGRES_DB: appdb\n      POSTGRES_PASSWORD_FILE: /run/secrets/db_password\n      TZ: UTC\n',
    'services:\n  api:\n    environment:\n      - API_KEY=${API_KEY}\n      - DB_PASSWORD=$DB_PASSWORD\n      - "SESSION_SECRET=${SESSION_SECRET:?required}"\n      - NODE_ENV=production\n',
    'steps:\n  - uses: actions/checkout@v4\n    with:\n      token: ${{ secrets.GITHUB_TOKEN }}\n',
    'valueFrom:\n  secretKeyRef:\n    name: db-credentials\n    key: password\n',
    'api_key: your-api-key-here\npassword: changeme\nsecret: <set me>\ntoken: xxxxxxxxxxxxxxxx\n',
    'password: !secret db_password\napi_token: *default_token\n',
    'auth:\n  enabled: true\n  provider: google-oauth2\n  token_ttl: 3600\n  password_min_length: 12\n',
    'DB_PASSWORD: __ZN_SECRET_1__\nAPI_KEY: __ZN_REDACTED_SECRET__\n',
    'secrets:\n  db_password:\n    file: ./secrets/db_password.txt\n',
    'session_secret: configService.sessionSecretValue\n',
    'database_url: postgres://app@db.internal:5432/appdb\n',
    'FROM node:20-alpine\nENV NODE_ENV=production\nARG APP_VERSION=1.4.1\nENV PATH /app/node_modules/.bin:$PATH\n',
    'docker run -e NODE_ENV=production -e API_KEY -e TOKEN=$TOKEN app:latest\n',
  ]) {
    assert.ok(untouched(t), t);
  }
});

test('hashes, colors, UUIDs and digests in non-sensitive fields are untouched', () => {
  for (const t of [
    'revision: ' + COMMIT + '\n',
    'commit_sha: ' + COMMIT + '\n',
    'GIT_COMMIT=' + COMMIT + '\n',
    'checksum: ' + SHA256 + '\n',
    'image: nginx@sha256:' + SHA256 + '\n',
    'theme:\n  primary: "#1f6feb"\n  accent: ff00aa\n',
    'request_id: ' + UUID + '\n',
    'public_key: ' + SHA256 + '\n',
    'cache:\n  key: ' + SHA256 + '\n',
  ]) {
    assert.ok(untouched(t), t);
  }
});

test('short hex and non-random values under a sensitive key are untouched', () => {
  for (const t of [
    'api_secret: ' + hex(24) + '\n',               // hex under 32 digits
    'api_secret: deadbeefdeadbeefdeadbeefdeadbeef\n',
    'password: 123456789012345\n',
    'token_secret: some-service-account-name\n',
    'auth_token: v1.2.3\n',
    'password: correct-horse-battery\n',
  ]) {
    assert.ok(untouched(t), t);
  }
});

/* ---------------- linear time ---------------- */

function timeMs(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

test('fingerprints, hashes, timestamps and storage keys are not secrets', () => {
  const h40 = hex(40);
  const h64 = hex(64);
  const docs = [
    'ENV GPG_KEY ' + h40.toUpperCase() + '\n',
    'gpg_key: ' + h40 + '\n',
    'signing_key_fingerprint: ' + h40 + '\n',
    'cache_key: ' + h64 + '\n',
    'idempotency_key: 550e8400-e29b-41d4-a716-446655440000\n',
    's3_key: uploads/2026/10/' + h64 + '.png\n',
    '"S3Key": "' + h64 + '.zip",\n',
    '"objectKey": "' + h64 + '.zip",\n',
    'password_sha256: ' + h64 + '\n',
    'token_hash: ' + h64 + '\n',
    'client_secret_expires_at: 1767225600\n',
  ];
  for (const doc of docs) {
    assert.deepStrictEqual(P.findPatterns(doc, {}), [], 'flagged: ' + doc.slice(0, 40));
  }
  // A GPG key id under another sensitive name is still a secret-like value.
  assert.strictEqual(P.findPatterns('api_key: ' + h40 + '\n', {}).length, 1);
});

test('a hash word that is not the end of the name does not skip it', () => {
  const h40 = hex(40);
  for (const doc of [
    'hash_key: ' + h40 + '\n',
    'COOKIE_HASH_KEY: ' + h40 + '\n',
    'session:\n  hashKey: ' + h40 + '\n',
    'HMAC_SHA256_KEY: ' + h40 + '\n',
    'HMAC_SHA256_SECRET: ' + h40 + '\n',
    'DIGEST_AUTH_PASSWORD: ' + h40 + '\n',
  ]) {
    assert.strictEqual(P.findPatterns(doc, {}).length, 1, 'missed: ' + doc.slice(0, 40));
  }
});

test('values must be printable ASCII', () => {
  // Localized text with Latin letters and digits mixed in, as in UI string
  // catalogs, has the character mix and entropy of a secret but is not ASCII.
  assert.deepStrictEqual(P.findPatterns('pass: "\u30d1\u30b9\u30ef\u30fc\u30c912\u6587\u5b57Abc9xZ"\n', {}), []);
});

test('64 KB worst-case inputs finish quickly (no super-linear backtracking)', () => {
  const N = 65536;
  const fill = (unit) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const inputs = {
    spaces: fill(' '),
    tabs_dash: fill('\t- '),
    long_key: fill('a'),
    key_colon: 'password: ' + fill('a'),
    key_colon_spaces: 'password: ' + fill('a '),
    key_eq: 'API_SECRET=' + fill('b'),
    eq_chain: fill('A='),
    colon_chain: fill('a: '),
    quotes: 'password: "' + fill('a'),
    hash_tail: 'password: ' + 'x'.repeat(100) + fill(' #'),
    env_flags: fill('-e A=b '),
    env_unterminated: fill(' --env A=') ,
    dockerfile_env: fill('ENV A '),
    lines: fill('password: Ab1Cd2Ef3Gh4\n'),
    compose_lines: fill('      - API_SECRET=Ab1Cd2Ef3Gh4Ij5\n'),
    // A value followed by a long run of blanks and one more character on the
    // same line, in each line form (the line tail must stay linear).
    yaml_value_spaces: 'password: Ab1Cd2Ef3Gh4Ij5' + fill(' ') + 'x',
    yaml_value_tabs: 'password: Ab1Cd2Ef3Gh4Ij5' + fill('\t') + 'x',
    dotenv_value_spaces: 'API_KEY=Ab1Cd2Ef3Gh4Ij5' + fill(' ') + 'x',
    compose_value_spaces: '- API_KEY=Ab1Cd2Ef3Gh4Ij5' + fill(' ') + 'x',
    dockerfile_value_spaces: 'ENV API_KEY Ab1Cd2Ef3Gh4Ij5' + fill(' ') + 'x',
    yaml_value_spaces_cr: 'password: Ab1Cd2Ef3Gh4Ij5' + fill(' \r') + 'x',
    // Repeated keywords in one line (generic assignment patterns).
    keyword_lower: fill('token'),
    keyword_upper: fill('TOKEN'),
    keyword_upper_eq: fill('API_TOKEN_') + '=',
  };
  for (const [name, text] of Object.entries(inputs)) {
    const ms = timeMs(() => P.findPatterns(text, {}));
    assert.ok(ms < 500, name + ' took ' + ms.toFixed(1) + ' ms');
  }
});

if (require.main === module) run('scrub patterns: structured config');
