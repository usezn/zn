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
const { budget } = require('./helpers/time_budget');

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
  ['SQUARE_TOKEN', () => 'EAAA' + pick(URLSAFE, 60)],
  ['SQUARE_TOKEN', () => 'sq0csp-' + pick(URLSAFE, 43)],
  // base64url of the 18-digit id 123456789012345678, a timestamp and an HMAC
  ['DISCORD_BOT_TOKEN', () => 'MTIzNDU2Nzg5MDEyMzQ1Njc4.' + pick(URLSAFE, 6) + '.' + pick(URLSAFE, 30)],
  // ids of 17 and 20 digits (the shortest and longest first parts)
  ['DISCORD_BOT_TOKEN', () => 'MTIzNDU2Nzg5MDEyMzQ1Njc.' + pick(URLSAFE, 6) + '.' + pick(URLSAFE, 27)],
  ['DISCORD_BOT_TOKEN', () => 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTA.' + pick(URLSAFE, 6) + '.' + pick(URLSAFE, 38)],
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
  assert.ok(ms < budget(50), 'twenty adversarial bodies took ' + ms.toFixed(1) + ' ms');
  const long = Array.from({ length: 423 }, () => unit + ' ').join('');
  assert.ok(long.length >= 16000 && long.length < 17000, String(long.length));
  t0 = process.hrtime.bigint();
  P.findPatterns(long, {});
  ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < budget(200), '16k-character text took ' + ms.toFixed(1) + ' ms');
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
    'Use AKIA as a prefix for access key ids',
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

/* ---------------- key-based PII: name, address, username ---------------- */

test('name, address and username are detected from an explicit header key', () => {
  assert.deepStrictEqual(pii('X-User-Name: Alice Example'), ['PERSON_NAME:Alice Example']);
  assert.deepStrictEqual(pii('x-full-name: Alice Example\r\nAccept: */*'), ['PERSON_NAME:Alice Example']);
  assert.deepStrictEqual(pii('X-Address: 1 Example Street, Springfield'), ['POSTAL_ADDRESS:1 Example Street, Springfield']);
  assert.deepStrictEqual(pii('X-Username: alice_ex'), ['USERNAME:alice_ex']);
  assert.deepStrictEqual(pii('X-User: alice_ex'), ['USERNAME:alice_ex']);
  assert.deepStrictEqual(pii("curl -H 'X-User-Name: Alice Example' https://example.com/a"), ['PERSON_NAME:Alice Example']);
  assert.deepStrictEqual(pii('{"headers": {"X-Username": "alice_ex"}}'), ['USERNAME:alice_ex']);
});

test('name, address and username are detected in query strings and form bodies', () => {
  assert.deepStrictEqual(
    pii('GET /a?full_name=Alice+Example&user=alice_ex&address=1%20Example%20Street&x=1'),
    ['PERSON_NAME:Alice+Example', 'POSTAL_ADDRESS:1%20Example%20Street', 'USERNAME:alice_ex']);
  assert.deepStrictEqual(pii('a=1&name=Alice%20Example&b=2'), ['PERSON_NAME:Alice%20Example']);
  assert.deepStrictEqual(pii('username=alice_ex&password_hint=x'), ['USERNAME:alice_ex']);
  assert.deepStrictEqual(pii('name=Alice Example\naddress=1 Example Street'), ['PERSON_NAME:Alice Example', 'POSTAL_ADDRESS:1 Example Street']);
});

test('only the value is the span; the key stays', () => {
  const t = 'X-User-Name: Alice Example';
  const s = P.findPii(t, {})[0];
  assert.strictEqual(t.slice(0, s.start), 'X-User-Name: ');
  assert.strictEqual(s.source, 'pii');
});

test('the same values without their key are not detected', () => {
  for (const t of ['Alice Example', 'hello Alice Example', '1 Example Street, Springfield', 'alice_ex', 'X-Request-Id: Alice Example',
    'Accept: Alice Example', 'filename=Alice Example', 'hostname=alice_ex', 'x.user=alice_ex']) {
    assert.deepStrictEqual(pii(t), [], t);
  }
});

test('key-based PII false-positive guards', () => {
  for (const t of [
    'X-User-Name:', 'X-User-Name: ', 'X-User: ubuntu', 'X-User: ${USER}', 'X-User-Name: <name>', 'X-Username: null',
    '?name=build', '?name=my-package', '?name=Alice', '&user=123456', '&user=root', 'username=',
    'user=git', 'user=postgres', 'username=mysql', '&user=nginx', '&user=deploy', 'USER=alice_ex', 'USERNAME=alice_ex', 'run(user=alice_ex)', '    user=alice_ex,', 'name=build\n', 'name = Alice Example',
    '?address=0x00000000219ab540356cbb839cbe05303d7705fa', '?address=192.0.2.1', 'X-Address: https://example.com/a b',
    '--user=alice_ex', 'X-Full-Name: {{name}}',
  ]) {
    assert.deepStrictEqual(pii(t), [], t);
  }
  // an e-mail value is left to the e-mail detector
  assert.deepStrictEqual(pii('?address=alice@example.com'), ['EMAIL:alice@example.com']);
  // a single given name is accepted only behind a name-specific key
  assert.deepStrictEqual(pii('?full_name=Alice'), ['PERSON_NAME:Alice']);
});

test('the pii setting turns the key-based types on and off one by one', () => {
  const text = 'X-User-Name: Alice Example\nX-Address: 1 Example Street, Springfield\nX-Username: alice_ex\n';
  assert.deepStrictEqual(pii(text, { pii: { name: false } }), ['POSTAL_ADDRESS:1 Example Street, Springfield', 'USERNAME:alice_ex']);
  assert.deepStrictEqual(pii(text, { pii: { address: false } }), ['PERSON_NAME:Alice Example', 'USERNAME:alice_ex']);
  assert.deepStrictEqual(pii(text, { pii: { username: false } }), ['PERSON_NAME:Alice Example', 'POSTAL_ADDRESS:1 Example Street, Springfield']);
  assert.strictEqual(P.PII_DEFAULTS.name && P.PII_DEFAULTS.address && P.PII_DEFAULTS.username, true);
});

test('the key-based types are PII, never secrets', () => {
  for (const t of ['PERSON_NAME', 'POSTAL_ADDRESS', 'USERNAME']) {
    assert.ok(P.PII_TYPES.includes(t));
    assert.ok(!P.SECRET_TYPES.includes(t));
  }
  assert.deepStrictEqual(P.findPatterns('X-User-Name: Alice Example\nX-Username: alice_ex', {}), []);
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

/* ---------------- Bearer tokens and URL passwords ---------------- */

test('BEARER_TOKEN: an opaque token is a span; markers, references and placeholders are not', () => {
  const token = 'ZNTESTFAKE' + pick(ALNUM, 24);
  const text = 'curl -H "Authorization: Bearer ' + token + '" https://api.example.com/v1';
  assert.ok(covers(text, token), text);
  assert.ok(types(text).includes('BEARER_TOKEN'));
  assert.ok(types('authorization:bearer ' + token).includes('BEARER_TOKEN'));
  for (const t of [
    'Authorization: Bearer __ZN_GITHUB_TOKEN__',
    'Authorization: Bearer $GITHUB_TOKEN_FOR_CI_JOBS',
    'Authorization: Bearer ${GITHUB_TOKEN_FOR_CI_JOBS}',
    'Authorization: Bearer <your-access-token-here>',
    'Authorization: Bearer xxxxxxxxxxxxxxxxxxxxxxxx',
    'Authorization: Bearer ' + token.slice(0, 19),
  ]) {
    assert.ok(!types(t).includes('BEARER_TOKEN'), t);
  }
});

test('URL_PASSWORD: a literal password is a span whatever the user; references are not', () => {
  const pw = 'ZNTESTFAKE' + pick(ALNUM, 12);
  for (const user of ['deploy', '${GIT_USER}', '$GIT_USER', '%GIT_USER%', 'x-access-token', 'oauth2']) {
    const text = 'git clone https://' + user + ':' + pw + '@git.example.com/org/repo.git';
    assert.ok(covers(text, pw), text);
    assert.ok(types(text).includes('URL_PASSWORD'), text);
  }
  assert.ok(covers('ssh://deploy:' + pw + '@git.example.com/org/repo.git', pw));
  for (const t of [
    'https://$TOKEN:x-oauth-basic@git.example.com/org/repo.git',
    'https://' + pw + ':x-oauth-basic@git.example.com/org/repo.git',
    'https://deploy:%GIT_PASSWORD%@git.example.com/org/repo.git',
    'https://deploy:${GIT_PASSWORD}@git.example.com/org/repo.git',
    'https://deploy:$GIT_PASSWORD@git.example.com/org/repo.git',
    'https://deploy:<password>@git.example.com/org/repo.git',
    'https://deploy:{{git_password}}@git.example.com/org/repo.git',
    'https://git.example.com/org/repo.git',
  ]) {
    assert.ok(!types(t).includes('URL_PASSWORD') && !types(t).includes('DB_PASSWORD'), t);
  }
});

test('BEARER_TOKEN and URL_PASSWORD stay fast on 100 KB adversarial inputs', () => {
  const size = 100 * 1024;
  const fill = (unit) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const inputs = [
    fill('Authorization: Bearer '),
    fill('authorization:'),
    'Authorization: Bearer ' + fill('a'),
    'Authorization: Bearer ' + fill('a.') + ' ',
    fill('https://a:'),
    fill('https://a:b'),
    'https://u:' + fill('a') + '@',
    fill('a://b:c@'),
    fill('://:'),
  ];
  for (const input of inputs) {
    const t0 = process.hrtime.bigint();
    P.findPatterns(input, {});
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < budget(500), 'findPatterns took ' + ms.toFixed(1) + ' ms on ' + JSON.stringify(input.slice(0, 16)));
  }
});

module.exports = { KNOWN_OK };

if (require.main === module) run('scrub patterns + PII');
void path;

test('Square and Discord near misses are not tokens', () => {
  for (const t of [
    'EAAA' + 'x'.repeat(59),
    // a dotted random string whose first part does not decode to a numeric id
    'MQa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4.Fg6Hj0.Ks1Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4Fg6Hj0',
  ]) assert.deepStrictEqual(types(t).filter((x) => x === 'SQUARE_TOKEN' || x === 'DISCORD_BOT_TOKEN'), [], t);
});

/* ---------------- provider formats from gitleaks v8.30.1 ---------------- */
// Deterministic fake bodies: a fixed alphabet cycled, so every run is the same and nothing looks like a real key.
const G_AL = 'Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4Fg6Hj0Ks', G_HX = '0123456789abcdef', G_LA = 'qa7zt3lm9pw2ny5rb8vx1cd4fg6hj0ks';
const G_B64 = G_AL + '+/', G_UR = G_AL + '-_';
const pickA = (n, alphabet = G_AL) => Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join('');
const uuidA = () => [pickA(8, G_HX), pickA(4, G_HX), pickA(4, G_HX), pickA(4, G_HX), pickA(12, G_HX)].join('-');
const GITLEAKS_FORMATS = [
  ['ONEPASSWORD_SA_TOKEN', 'ops_eyJ' + pickA(250, G_B64), 'ops_eyJ' + pickA(249, G_B64)],
  ['AGE_SECRET_KEY', 'AGE-SECRET-KEY-1' + pickA(58, 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L'), 'AGE-SECRET-KEY-1' + pickA(57, 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L')],
  ['ALIBABA_KEY_ID', 'LTAI' + pickA(20), 'LTAI' + pickA(19)],
  ['ARTIFACTORY_KEY', 'AKCp' + pickA(69), 'AKCp' + pickA(68)],
  ['CLOUDFLARE_ORIGIN_CA_KEY', 'v1.0-' + pickA(24, G_HX) + '-' + pickA(146, G_HX), 'v1.0-' + pickA(24, G_HX) + '-' + pickA(145, G_HX)],
  ['DYNATRACE_TOKEN', 'dt0c01.' + pickA(24) + '.' + pickA(64), 'dt0c01.' + pickA(23) + '.' + pickA(64)],
  ['EASYPOST_KEY', 'EZAK' + pickA(54), 'EZAK' + pickA(53)],
  ['FLYIO_TOKEN', 'fo1_' + pickA(43, G_UR), 'fo1_' + pickA(42, G_UR)],
  ['GRAFANA_TOKEN', 'glsa_' + pickA(32) + '_' + pickA(8, G_HX), 'glsa_' + pickA(31) + '_' + pickA(8, G_HX)],
  ['TERRAFORM_CLOUD_TOKEN', pickA(14, G_LA) + '.atlasv1.' + pickA(64, G_UR), pickA(14, G_LA) + '.atlasv1.' + pickA(59, G_UR)],
  ['HEROKU_KEY_V2', 'HRKU-AA' + pickA(58, G_UR), 'HRKU-AA' + pickA(57, G_UR)],
  ['NOTION_TOKEN', 'ntn_' + pickA(11, '0123456789') + pickA(35), 'ntn_' + pickA(11, '0123456789') + pickA(34)],
  ['PERPLEXITY_KEY', 'pplx-' + pickA(48), 'pplx-' + pickA(47)],
  ['PLANETSCALE_TOKEN', 'pscale_tkn_' + pickA(40, G_UR), 'pscale_tkn_' + pickA(31, G_UR)],
  ['POSTMAN_KEY', 'PMAK-' + pickA(24, G_HX) + '-' + pickA(34, G_HX), 'PMAK-' + pickA(24, G_HX) + '-' + pickA(33, G_HX)],
  ['PREFECT_KEY', 'pnu_' + pickA(36), 'pnu_' + pickA(35)],
  ['PULUMI_TOKEN', 'pul-' + pickA(40, G_HX), 'pul-' + pickA(39, G_HX)],
  ['README_KEY', 'rdme_' + pickA(70, G_LA), 'rdme_' + pickA(69, G_LA)],
  ['RUBYGEMS_KEY', 'rubygems_' + pickA(48, G_HX), 'rubygems_' + pickA(47, G_HX)],
  ['BREVO_KEY', 'xkeysib-' + pickA(64, G_HX) + '-' + pickA(16), 'xkeysib-' + pickA(64, G_HX) + '-' + pickA(15)],
  ['SENTRY_USER_TOKEN', 'sntryu_' + pickA(64, G_HX), 'sntryu_' + pickA(63, G_HX)],
  ['SHIPPO_KEY', 'shippo_live_' + pickA(40, G_HX), 'shippo_live_' + pickA(39, G_HX)],
  ['OPENSHIFT_TOKEN', 'sha256~' + pickA(43, G_UR), 'sha256~' + pickA(42, G_UR)],
  ['TEAMS_WEBHOOK', 'https://example.webhook.office.com/webhookb2/' + uuidA() + '@' + uuidA() + '/IncomingWebhook/' + pickA(32, G_HX) + '/' + uuidA(), 'https://example.webhook.office.com/webhookb2/' + uuidA() + '@' + uuidA() + '/IncomingWebhook/' + pickA(31, G_HX) + '/' + uuidA()],
  ['FLYIO_TOKEN', 'fm1a_' + pickA(100, G_B64), 'fm1a_' + pickA(99, G_B64)],
  ['FLYIO_TOKEN', 'fm1r_' + pickA(120, G_B64) + '==', 'fm1r_' + pickA(99, G_B64)],
  ['FLYIO_TOKEN', 'fm2_' + pickA(100, G_B64), 'fm2_' + pickA(99, G_B64)],
  ['GRAFANA_TOKEN', 'glc_' + pickA(32, G_B64), 'glc_' + pickA(31, G_B64)],
  ['EASYPOST_KEY', 'EZTK' + pickA(54), 'EZTK' + pickA(53)],
  ['PLANETSCALE_TOKEN', 'pscale_oauth_' + pickA(40, G_UR), 'pscale_oauth_' + pickA(31, G_UR)],
  ['PLANETSCALE_TOKEN', 'pscale_pw_' + pickA(40, G_UR), 'pscale_pw_' + pickA(31, G_UR)],
  ['SHIPPO_KEY', 'shippo_test_' + pickA(40, G_HX), 'shippo_test_' + pickA(39, G_HX)],
  ['POSTMAN_KEY', 'PMAK-' + pickA(24, G_HX).toUpperCase() + '-' + pickA(34, G_HX).toUpperCase(), 'PMAK-' + pickA(24, G_HX).toUpperCase() + '-' + pickA(33, G_HX).toUpperCase()],
  // one character too many, and a prefix glued to a longer word
  ['ALIBABA_KEY_ID', 'key LTAI' + pickA(20) + ' end', 'key LTAI' + pickA(21) + ' end'],
  ['ALIBABA_KEY_ID', 'id=LTAI' + pickA(20), 'id=xLTAI' + pickA(20)],
  ['PULUMI_TOKEN', 'pul-' + pickA(40, G_HX), 'pul-' + pickA(41, G_HX)],
];
test('provider formats from gitleaks: each positive is found, each near miss is not', () => {
  for (const [type, pos, neg] of GITLEAKS_FORMATS) {
    assert.ok(types(pos).includes(type), type + ' positive');
    assert.ok(!types(neg).includes(type), type + ' near miss');
  }
});
test('provider formats from gitleaks: placeholder bodies are not tokens', () => {
  for (const t of ['pnu_' + '0'.repeat(36), 'pul-' + 'a'.repeat(40), 'sha256~' + 'x'.repeat(43), 'LTAI' + 'X'.repeat(20),
    'sha256~abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ', 'pul-' + '0123456789abcdef'.repeat(3).slice(0, 40),
    'LTAIabcdefghijKLMNOP1234']) {
    assert.deepStrictEqual(types(t), [], t);
  }
});

test('AWS key ids ending in EXAMPLE are redacted for every prefix', () => {
  for (const prefix of ['AKIA', 'ASIA', 'ABIA', 'ACCA']) {
    const t = 'key ' + prefix + 'IOSFODNN7' + 'EXAMPLE' + ' here';
    assert.deepStrictEqual(types(t), ['AWS_KEY'], t);
  }
});

test('phone numbers: international form with single separators is redacted', () => {
  for (const t of ['+34 600 000 000', '+1 202-555-0143', '+44 20 7946 0958', '+44.20.7946.0958', '+1 202.555.0199', '+34600000000', '+33 1 23 45 67 89', '+34 600123456', '+44 7700900123', '+33 612345678', '+1 2025550143', '+49 15123456789']) {
    assert.deepStrictEqual(P.findPii('call ' + t + ' now', {}).map((s) => s.type), ['PHONE'], t);
    const spans = P.findPii('call ' + t + ' now', {});
    assert.strictEqual(spans[0].end - spans[0].start, t.length, t);
  }
  const text = 'tel +44 20 7946 0958, alt +1 202-555-0143.';
  const found = require('../lib/scrub/engine').scan(text);
  assert.deepStrictEqual(found.map((s) => text.slice(s.start, s.end)), ['+44 20 7946 0958', '+1 202-555-0143']);
});

test('phone numbers: national formats and look-alikes stay unflagged', () => {
  for (const t of ['(202) 555-0143', '202-555-0143', '020 7946 0958', '1.2.3-4', 'v1.2.3-4', '2026-10-30', '+2026-10-30 12:00', '+2026-10-30 1234',
    '192.0.2.10', '+192.0.2.10', '+198.51.100.200', 'a = 1 + 2 - 3', '1+2-3', 'x+1 2 3', '^1.2.3 || >=2.0.0 <3.0.0', '~1.2.3 +build.5',
    '550e8400-e29b-41d4-a716-446655440000', '+550e8400-e29b-41d4-a716-446655440000', 'deadbeefdeadbeefdeadbeefdeadbeef', '+1 2026-10-30',
    '$1,234.56', '+$12.50 plus 3 - 4', 'total 1 200 300 400', '+44 20 79', '+44 7946', '+1.2.3.4.5.6.7.8', '+1 202 555', '++34 600 000 000', '+34 60012345', '+34 6001234567', '+34 600123456789', '+999 123456789', '+7 1234567890', '+2 1234567', 'x +1 2026', '+12 20261030', 'a +34 6001234567 b', '+34 0600123456']) {
    assert.ok(!P.findPii(t, {}).some((s) => s.type === 'PHONE'), t);
  }
});
