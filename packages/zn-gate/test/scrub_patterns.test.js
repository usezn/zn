'use strict';
/**
 * Pattern and PII layer. Every secret value here is generated at run time
 * from a seeded PRNG with public format prefixes only: fake, never real.
 */
const assert = require('assert');
const path = require('path');
const { test, run } = require('./_harness');
const P = require('../lib/scrub/patterns');
const { generateAll, mulberry32 } = require('./fixtures/fake_secrets');

const rnd = mulberry32(424242);
const pick = (chars, n) => { let s = ''; for (let i = 0; i < n; i++) s += chars[Math.floor(rnd() * chars.length)]; return s; };
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';
const URLSAFE = ALNUM + '_-';
const B64 = ALNUM + '+/';
const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function types(text) {
  return P.findPatterns(text, {}).map((s) => s.type);
}

function covers(text, value) {
  const spans = P.findPatterns(text, {});
  const at = text.indexOf(value);
  return spans.some((s) => s.start <= at && s.end >= at + value.length);
}

/* ---------------- secrets from the shared fake generator ---------------- */

test('every fake secret type of the leak bench is covered by the pattern layer', () => {
  const { secrets } = generateAll(1337005, { perType: 3 });
  for (const s of secrets) {
    const text = 'value: ' + s.value + '\n';
    if (s.type === 'aws_secret_access_key') {
      assert.ok(covers('aws_secret_access_key = ' + s.value + '\n', s.sensitive), s.type);
      continue;
    }
    assert.ok(covers(text, s.sensitive.trim()), s.type + ' not covered: ' + s.value.slice(0, 12));
  }
});

test('connection strings: only the password is a span', () => {
  const pw = pick(URLSAFE, 24);
  const text = 'DATABASE_URL=postgres://app_rw:' + pw + '@db.internal:5432/appdb\n';
  const spans = P.findPatterns(text, {});
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(text.slice(spans[0].start, spans[0].end), pw);
  assert.strictEqual(spans[0].type, 'DB_PASSWORD');
  const redis = 'redis://:' + pw + '@cache.internal:6379/0';
  assert.strictEqual(redis.slice(P.findPatterns(redis, {})[0].start, P.findPatterns(redis, {})[0].end), pw);
  const https = 'https://deploy:' + pw + '@git.example.org/repo.git';
  assert.deepStrictEqual(types(https), ['URL_PASSWORD']);
});

test('connection strings without a real password are untouched', () => {
  for (const t of [
    'postgres://app@db.internal:5432/appdb',
    'postgres://postgres:postgres@localhost:5432/db',
    'mysql://user:password@localhost/db',
    'mongodb://admin:${MONGO_PASSWORD}@mongo:27017',
    'http://user:pass@example.com/',
    'ftp://joe:<password>@ftp.example.org',
    'amqp://guest:guest@rabbit:5672/',
    'postgres://app:changeme@db/app',
  ]) {
    assert.deepStrictEqual(types(t), [], t);
  }
});

/* ---------------- additional prefix types ---------------- */

const EXTRA = [
  ['STRIPE_WEBHOOK_SECRET', () => 'whsec_' + pick(ALNUM, 32)],
  ['GOOGLE_OAUTH_SECRET', () => 'GOCSPX-' + pick(URLSAFE, 28)],
  ['PYPI_TOKEN', () => 'pypi-AgEIcHlwaS5vcmc' + pick(URLSAFE, 60)],
  ['TWILIO_KEY', () => 'SK' + pick(HEX, 30) + 'a1'],
  ['MAILGUN_KEY', () => 'key-' + pick(HEX, 30) + 'b2'],
  ['SHOPIFY_TOKEN', () => 'shpat_' + pick(HEX, 32)],
  ['DIGITALOCEAN_TOKEN', () => 'dop_v1_' + pick(HEX, 64)],
  ['LINEAR_KEY', () => 'lin_api_' + pick(ALNUM, 40)],
  ['TELEGRAM_BOT_TOKEN', () => '123456789:AA' + pick(URLSAFE, 33)],
  ['DATABRICKS_TOKEN', () => 'dapi' + pick(HEX, 30) + 'c3'],
  ['VAULT_TOKEN', () => 'hvs.' + pick(URLSAFE, 90)],
  ['DOPPLER_TOKEN', () => 'dp.st.' + pick(ALNUM, 40)],
  ['NEWRELIC_KEY', () => 'NRAK-' + pick(UPPER_DIGITS, 27)],
  ['GROQ_KEY', () => 'gsk_' + pick(ALNUM, 52)],
  ['XAI_KEY', () => 'xai-' + pick(ALNUM, 80)],
  ['SLACK_WEBHOOK', () => 'https://hooks.slack.com/services/T' + pick(UPPER_DIGITS, 8) + '/B' + pick(UPPER_DIGITS, 8) + '/' + pick(ALNUM, 24)],
  ['DISCORD_WEBHOOK', () => 'https://discord.com/api/webhooks/' + '1'.repeat(1) + pick('0123456789', 17) + '/' + pick(URLSAFE, 68)],
  ['GITHUB_TOKEN', () => 'ghu_' + pick(ALNUM, 36)],
  ['ANTHROPIC_KEY', () => 'sk-ant-admin01-' + pick(URLSAFE, 93)],
  ['DOCKERHUB_PAT', () => 'dckr_pat_' + pick(URLSAFE, 27)],
  ['TAVILY_KEY', () => 'tvly-' + pick(ALNUM, 30) + 'a1'],
  ['FIRECRAWL_KEY', () => 'fc-' + pick(HEX, 30) + 'b2'],
  ['POLAR_TOKEN', () => 'polar_oat_' + pick(ALNUM, 40)],
  ['POLAR_TOKEN', () => 'polar_at_u_' + pick(ALNUM, 40)],
  ['POLAR_TOKEN', () => 'polar_at_o_' + pick(ALNUM, 40)],
  ['POLAR_TOKEN', () => 'polar_ci_' + pick(ALNUM, 40)],
  ['POLAR_TOKEN', () => 'polar_cs_' + pick(ALNUM, 40)],
  ['REPLICATE_TOKEN', () => 'r8_' + pick(ALNUM, 37)],
  ['SUPABASE_PAT', () => 'sbp_' + pick(ALNUM, 40)],
  ['AZURE_AD_CLIENT_SECRET', () => 'abc9Q~' + pick(URLSAFE, 32)],
  ['HF_TOKEN', () => 'hf_' + pick(ALNUM.slice(0, 52), 34)],
  ['STRIPE_KEY', () => 'sk_prod_' + pick(ALNUM, 24) + 'a1'],
  ['TWILIO_KEY', () => 'SK' + pick('0123456789ABCDEF', 30) + 'C3'],
  ['OPENAI_KEY', () => 'sk-' + pick(HEX, 30) + 'a1'],
  ['DOCKERHUB_PAT', () => 'dckr_oat_' + pick(URLSAFE, 27)],
  ['TAVILY_KEY', () => 'tvly-dev-' + pick(ALNUM, 30) + 'a1'],
  ['POLAR_TOKEN', () => 'polar_pat_' + pick(ALNUM, 40)],
  ['POLAR_TOKEN', () => 'polar_rt_u_' + pick(ALNUM, 40)],
  ['POLAR_TOKEN', () => 'polar_rt_o_' + pick(ALNUM, 40)],
];

test('additional prefix types are detected in context', () => {
  for (const [type, gen] of EXTRA) {
    const v = gen();
    const text = 'config: "' + v + '"\n';
    assert.ok(types(text).includes(type), type + ' not detected');
    assert.ok(covers(text, v), type + ' not fully covered');
  }
});

/* Near-miss lengths, prefix words and slugs of the new and extended formats
 * must stay untouched. Every value is generated or built from parts. */
test('new and extended formats: near-miss lengths and look-alikes are not secrets', () => {
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const ALPHA = ALNUM.slice(0, 52);
  const HF_PASCAL = 'ModelLoaderConfigFactoryModuleHelper'.slice(0, 34);
  assert.strictEqual(HF_PASCAL.length, 34);
  for (const t of [
    'dckr_pat_' + pick(URLSAFE, 19),                        // Docker Hub: below the 20-character minimum
    'Create a dckr_pat_ token under Account Settings',      // prefix in prose
    'tvly-' + pick(ALNUM, 12),                              // Tavily: too short
    'tvly-' + lower + lower.slice(0, 4),                    // Tavily: no digit
    'fc-' + pick(ALNUM, 8),                                 // Firecrawl: too short
    'fc-barcelona',                                         // slug
    'class="fc-icon-small-grid-layout"',                    // CSS class
    'polar_oat_' + pick(ALNUM, 12),                         // Polar: too short
    'polar_bear_classifier_training',                       // not a Polar prefix
    'polar_ci_' + 'a'.repeat(25),                           // one character class
    'r8_' + pick(ALNUM, 36),                                // Replicate: 39 characters in total
    'r8_' + pick(ALNUM, 38),                                // Replicate: 41 characters in total
    'r8_model_v2',                                          // prefix word
    'sbp_' + pick(ALNUM, 20),                               // Supabase: too short
    'sbp_' + lower + lower,                                 // Supabase: no digit
    'abc9Q~' + pick(URLSAFE, 20),                           // Azure: body too short
    'abc9Q~' + pick(URLSAFE, 40),                           // Azure: body too long
    'Q~ is the tilde-Q notation in math',                   // no prefix shape
    'hf_' + pick(ALPHA, 33),                                // letters only, one short
    'hf_' + pick(ALPHA, 41),                                // letters only, one too long
    'sk_prod_' + pick(ALNUM, 4),                            // Stripe: too short
    'SK' + pick('0123456789ABCDEF', 31),                    // Twilio: 31 hex digits
    'SK' + '0'.repeat(32),                                  // Twilio: placeholder, no letter
    'sk-' + pick(HEX, 31),                                  // legacy sk-: 31 hex digits
    'sk-' + 'a'.repeat(32),                                 // legacy sk-: one character class
    'task-' + pick(HEX, 32),                                // sk- inside a word
    'dckr_oat_' + pick(URLSAFE, 19),                        // Docker Hub org token: below the minimum
    'polar_rt_x' + pick(ALNUM, 12),                         // Polar refresh prefix, too short
    'polar_pat_' + 'a'.repeat(25),                          // Polar: one character class
    'hf_' + HF_PASCAL,                                      // 34-letter PascalCase identifier
    'SK' + pick('0123456789abcdef', 15) + 'a' + pick('0123456789ABCDEF', 15) + 'B', // Twilio: mixed case, letters pinned
    'Set the secret to ' + 'abc9Q~' + pick(URLSAFE, 31) + '9.json.',    // Azure: dotted continuation
  ]) {
    assert.deepStrictEqual(types(t), [], t);
  }
});

/* The HF identifier check must stay linear: adversarial bodies with long
 * lowercase runs followed by uppercase letters used to backtrack badly. */
test('HF letters-only check is linear on adversarial bodies', () => {
  const unit = 'hf_' + 'a'.repeat(30) + 'AAAA';
  const many = Array.from({ length: 20 }, () => unit).join(' ');
  let t0 = process.hrtime.bigint();
  P.findPatterns(many, {});
  let ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 50, 'twenty adversarial bodies took ' + ms.toFixed(1) + ' ms');
  const long = Array.from({ length: 423 }, () => unit + ' ').join('');
  assert.ok(long.length >= 16000 && long.length < 17000, String(long.length));
  t0 = process.hrtime.bigint();
  P.findPatterns(long, {});
  ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 200, '16k-character text took ' + ms.toFixed(1) + ' ms');
});

test('Azure AD client secret at the end of a sentence: the full stop is not part of the span', () => {
  const secret = 'abc9Q~' + pick(URLSAFE, 15) + '.' + pick(URLSAFE, 15) + '9';
  assert.strictEqual(secret.length, 38);
  const text = 'Set the client secret to ' + secret + '. Rotate it soon.\n';
  const spans = P.findPatterns(text, {}).filter((s) => s.type === 'AZURE_AD_CLIENT_SECRET');
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(text.slice(spans[0].start, spans[0].end), secret);
  const dotted = 'Set the client secret to ' + secret + '.json.\n';
  assert.strictEqual(P.findPatterns(dotted, {}).filter((s) => s.type === 'AZURE_AD_CLIENT_SECRET').length, 0);
});

test('Azure storage key: only the key is a span', () => {
  const key = pick(B64, 86) + '==';
  const text = 'DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=' + key + ';EndpointSuffix=core.windows.net';
  const spans = P.findPatterns(text, {});
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(text.slice(spans[0].start, spans[0].end), key);
});

test('private key blocks are covered whole, indented or truncated', () => {
  const label = 'RSA PRIVATE' + ' KEY';
  const body = Array.from({ length: 6 }, () => pick(B64, 64));
  const pem = '-----BEGIN ' + label + '-----\n' + body.join('\n') + '\n-----END ' + label + '-----';
  const yaml = 'tls:\n  key: |\n    ' + pem.split('\n').join('\n    ') + '\n';
  const spans = P.findPatterns(yaml, {});
  assert.strictEqual(spans.length, 1);
  const covered = yaml.slice(spans[0].start, spans[0].end);
  for (const line of body) assert.ok(covered.includes(line));
  const truncated = 'cat key.pem\n-----BEGIN ' + label + '-----\n' + body.slice(0, 3).join('\n') + '\n';
  const t = P.findPatterns(truncated, {});
  assert.strictEqual(t.length, 1);
  for (const line of body.slice(0, 3)) assert.ok(truncated.slice(t[0].start, t[0].end).includes(line));
});

test('generic assignments need a sensitive key and a random-looking value', () => {
  const v = pick(ALNUM, 24) + '9aZ';
  assert.ok(types('const password = "' + v + '";').includes('SECRET'));
  assert.ok(types('API_TOKEN=' + v + '\n').includes('SECRET'));
  for (const t of [
    'password = "changeme123456"',
    'token: "Bearer ${TOKEN}"',
    'secret = "my_secret_name_here"',
    'api_key = process.env.API_KEY',
    'password = "aaaaaaaaaaaaaaaaaaaa"',
    'passwordField = "user_password_input"',
  ]) {
    assert.deepStrictEqual(types(t), [], t);
  }
});

test('the 13 fixed must-not-touch snippets stay intact in the pattern layer', () => {
  for (const t of KNOWN_OK) assert.deepStrictEqual(types(t), [], t);
});

test('prefixes quoted in docs and look-alikes are not secrets', () => {
  for (const t of [
    'Anthropic keys start with sk-ant- and OpenAI keys with sk-.',
    'Use AKIA as prefix; e.g. AKIAIOSFODNN7EXAMPLE',
    'github tokens look like ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'commit 3f786850e387550fdab836ed7e6dc881de23001b',
    'sha1: 2fd4e1c67a2d28fced849ee1bb76e7391b93eb12 and aws secret mention',
    'npm_config_cache=/home/user/.npm',
    'hf_hub_download(repo_id, filename)',
    '"integrity": "sha512-' + pick(B64, 86) + '=="',
  ]) {
    assert.deepStrictEqual(types(t), [], t);
  }
});

/* ---------------- PII ---------------- */

function pii(text, opts) {
  return P.findPii(text, opts || {}).map((s) => s.type + ':' + text.slice(s.start, s.end));
}

test('PII from the shared generator is detected', () => {
  const { pii: list } = generateAll(1337005, { perType: 1, piiPerType: 4 });
  const expected = { email: 'EMAIL', phone_e164: 'PHONE', iban: 'IBAN', payment_card: 'CARD', dni: 'DNI', nie: 'NIE' };
  for (const p of list) {
    const found = pii('Customer record: ' + p.value + ' (synthetic)');
    assert.deepStrictEqual(found, [expected[p.type] + ':' + p.value], p.type + ' ' + p.value);
  }
});

test('validators: Luhn, IBAN mod-97, DNI/NIE letter, SSN, E.164', () => {
  assert.ok(P.luhnValid('4242424242424242'));
  assert.ok(!P.luhnValid('4242424242424241'));
  assert.ok(P.cardValid('3782 822463 10005'));     // validator ignores grouping
  assert.ok(P.cardValid('378282246310005'));
  assert.ok(P.cardValid('4242-4242-4242-4242'));
  assert.ok(!P.cardValid('1234567812345670'));   // no network prefix
  assert.ok(P.ibanValid('GB82 WEST 1234 5698 7654 32'));
  assert.ok(!P.ibanValid('GB82 WEST 1234 5698 7654 33'));
  assert.ok(!P.ibanValid('DE89370400440532013000'.slice(0, 21)));
  assert.ok(P.dniValid('12345678Z'));
  assert.ok(!P.dniValid('12345678A'));
  assert.ok(P.nieValid('X0000000T'));
  assert.ok(!P.nieValid('X0000000A'));
  assert.ok(P.ssnValid('123-45-6780'));
  assert.ok(!P.ssnValid('000-12-3456'));
  assert.ok(!P.ssnValid('666-12-3456'));
  assert.ok(!P.ssnValid('912-12-3456'));
  assert.ok(P.e164Valid('+12025550142'));
  assert.ok(!P.e164Valid('+15550142'));
  assert.ok(!P.e164Valid('+1234567890'));
  assert.ok(P.e164Valid('+447700900123'));
  assert.ok(P.e164Valid('+33612345678'));
  assert.ok(!P.e164Valid('+3361234567'));
});

test('PII look-alikes in code are not PII', () => {
  for (const t of [
    '@property\ndef name(self):',
    'git@github.com:usezn/zn.git',
    'postgres://app@db.internal:5432/appdb',
    'icon@2x.png and logo@3x.webp',
    'npm i lodash@4.17.21',
    'version 2026-10-11 build 1234567890123',
    'uuid 550e8400-e29b-41d4-a716-446655440000',
    'x = 1234567812345678 # not a card network',
    'call +1234567890 for a demo',
    'ref 12345678A is not a DNI',
    'date 2026-10-11',
  ]) {
    assert.deepStrictEqual(pii(t), [], t);
  }
});

test('public IPv4 is opt-in', () => {
  assert.deepStrictEqual(pii('host 8.8.8.8'), []);
  assert.deepStrictEqual(pii('host 8.8.8.8', { pii: { ipv4: true } }), ['IPV4:8.8.8.8']);
  assert.deepStrictEqual(pii('host 10.0.0.1 and 192.168.1.1', { pii: { ipv4: true } }), []);
});

const KNOWN_OK = [
  'commit 3f786850e387550fdab836ed7e6dc881de23001b fix: bump deps\n',
  'session id: 550e8400-e29b-41d4-a716-446655440000\n',
  'payload_sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n',
  '"integrity": "sha512-9cW9xR2mQ4t6V8yF1nZ3kL5pJ7hG0dS2aB4cD6eF8gH7iJ9kL0mN1oP2qR3sT4uV5wX6yZ7aB8cD9eF0fG1hI2jK3lM4nO5pQ6rS7tU8vW9xY0zA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1vW2xY3zZ4aB5cD6e=="\n',
  'const key = process.env.API_KEY;\n',
  'Tokens start with sk-ant- and must be rotated every 90 days.\n',
  'postgres://app@db.internal:5432/appdb\n',
  "const token = jwt.sign({ sub: user.id }, secret, { expiresIn: '1h' });\n",
  'curl https://api.example.org/v1/ping\n',
  '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n',
  'lodash version 4.17.21, node >=18.0.0\n',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==\n',
  'resolved "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"\n',
];

test('the 13 fixed snippets carry no PII either', () => {
  for (const t of KNOWN_OK) assert.deepStrictEqual(pii(t), [], t);
});

module.exports = { KNOWN_OK };

if (require.main === module) run('scrub patterns + PII');
void path;
