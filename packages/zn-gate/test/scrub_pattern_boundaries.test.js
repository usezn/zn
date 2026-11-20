'use strict';
/**
 * Boundary cases of the pattern and PII layer that the mutation run found
 * untested: the Anthropic and bearer masks, the placeholder regex, the AWS
 * secret token boundaries, the E.164 validator, phone shapes and the findPii
 * options. Every secret-like value is assembled at run time from fragments;
 * all digits and letters are fake.
 */
const assert = require('assert');
const { test, run } = require('./_harness');
const P = require('../lib/scrub/patterns');

const ANT = 'sk-' + 'ant-' + 'api03-';
const GH = 'gh' + 'p_';
const XOX = 'xo' + 'xb-';
const BEARER = 'Authorization: Bearer ';
const AWS_CTX = 'aws_secret_access_key';
const AWS_BODY = 'aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA3bC5x';

const types = (text) => P.findPatterns(text, {}).map((s) => s.type);
const piiTypes = (text, opts) => P.findPii(text, opts || {}).map((s) => s.type);
const bearerSpans = (token) => P.findPatterns(BEARER + token, {}).filter((s) => s.type === 'BEARER_TOKEN');
const awsSecrets = (text) => P.findPatterns(text, {}).filter((s) => s.type === 'AWS_SECRET').map((s) => text.slice(s.start, s.end));

/* ---- Anthropic key mask (maskedBody, 75 % filler and at most 8 other characters) ---- */

test('Anthropic key: a random-looking body is reported', () => {
  assert.ok(types(ANT + AWS_BODY).includes('ANTHROPIC_KEY'));
});

test('Anthropic key: exactly 75 % filler with 8 other characters is masked, not reported', () => {
  assert.ok(!types(ANT + 'x'.repeat(24) + 'Q'.repeat(8)).includes('ANTHROPIC_KEY'));
});

test('Anthropic key: 9 non-filler characters break the mask, the key is reported', () => {
  assert.ok(types(ANT + 'x'.repeat(23) + 'Q'.repeat(9)).includes('ANTHROPIC_KEY'));
});

test('Anthropic key: uppercase X, dash and underscore count as filler', () => {
  for (const f of ['X', '-', '_']) {
    assert.ok(!types(ANT + f.repeat(24) + 'Q'.repeat(8)).includes('ANTHROPIC_KEY'), 'filler ' + f);
  }
});

test('Anthropic key: A and 0 are not filler, so such a body is reported', () => {
  for (const f of ['A', '0']) {
    assert.ok(types(ANT + f.repeat(24) + 'Q'.repeat(8)).includes('ANTHROPIC_KEY'), 'not filler ' + f);
  }
});

/* ---- Bearer token mask (same mask, after a known prefix is stripped) ---- */

test('bearer: exactly 75 % filler in a 20-character token is masked', () => {
  assert.equal(bearerSpans('x'.repeat(15) + 'Q'.repeat(5)).length, 0);
});

test('bearer: 14 filler characters in a 20-character token is reported', () => {
  assert.equal(bearerSpans('x'.repeat(14) + 'Q'.repeat(6)).length, 1);
});

test('bearer: a known provider prefix is stripped before the filler count', () => {
  for (const pre of ['sk-', ANT, XOX, GH]) {
    assert.equal(bearerSpans(pre + 'x'.repeat(13) + 'Q'.repeat(4)).length, 0, 'prefix ' + pre);
  }
});

test('bearer: a single character repeated with hyphens is not a token', () => {
  assert.equal(bearerSpans(Array(11).fill('Q').join('-')).length, 0);
});

test('bearer: the span is the token alone, not the header', () => {
  const token = 'Zk3Lm9Qp2Rt7Vb4Nx8Hc1Wd6';
  const text = BEARER + token;
  const spans = P.findPatterns(text, {}).filter((s) => s.type === 'BEARER_TOKEN');
  assert.equal(spans.length, 1);
  assert.equal(text.slice(spans[0].start, spans[0].end), token);
});

/* ---- Placeholder regex (exported isPlaceholder) ---- */

test('placeholder: a single dash or underscore is a placeholder', () => {
  assert.ok(P.isPlaceholder('-'));
  assert.ok(P.isPlaceholder('_'));
});

test('placeholder: angle, dollar, brace, percent, colon and bracket forms', () => {
  for (const v of ['<a>', '<token>', '${TOKEN}', '$TOKEN', '{{name}}', '{name}', '%(pw)s', '%s', ':api_key', ':API_KEY', '[token]']) {
    assert.ok(P.isPlaceholder(v), v);
  }
});

test('placeholder: the whole value must have the placeholder form', () => {
  for (const v of ['<a>b', '[a]b', ':a b', '%(pw)d', 'x<a>']) {
    assert.ok(!P.isPlaceholder(v), v);
  }
});

test('placeholder: empty input counts as a placeholder', () => {
  assert.ok(P.isPlaceholder(''));
  assert.ok(P.isPlaceholder(null));
});

/* ---- AWS secret access key boundaries (NB64 and NA64 token alphabet) ---- */

test('AWS secret: the body is 40 characters', () => {
  assert.equal(AWS_BODY.length, 40);
});

test('AWS secret: a 40-character body after the key name is reported, span is the body', () => {
  assert.deepStrictEqual(awsSecrets(AWS_CTX + ' = ' + AWS_BODY), [AWS_BODY]);
  assert.deepStrictEqual(awsSecrets(AWS_CTX + '=' + AWS_BODY), [AWS_BODY]);
});

test('AWS secret: a 39-character body is not reported', () => {
  assert.deepStrictEqual(awsSecrets(AWS_CTX + '=' + AWS_BODY.slice(0, 39)), []);
});

test('AWS secret: a body followed by a token-alphabet character is not reported', () => {
  for (const c of ['+', '/', '=', '_', '-']) {
    assert.deepStrictEqual(awsSecrets(AWS_CTX + '=' + AWS_BODY + c), [], 'after ' + c);
  }
});

test('AWS secret: a comma after the body still ends the token', () => {
  assert.deepStrictEqual(awsSecrets(AWS_CTX + '=' + AWS_BODY + ','), [AWS_BODY]);
});

test('AWS secret: a body preceded by a token-alphabet character is not reported', () => {
  for (const c of ['+', '/', '_', '-']) {
    assert.deepStrictEqual(awsSecrets(AWS_CTX + '=' + c + AWS_BODY), [], 'before ' + c);
  }
});

/* ---- E.164 validator (exported e164Valid) ---- */

test('E.164: country code 34 needs exactly nine national digits', () => {
  assert.ok(P.e164Valid('+34600123456'));
  assert.ok(!P.e164Valid('+3460012345'));
  assert.ok(!P.e164Valid('+346001234567'));
});

test('E.164: 351 is a three-digit country code with nine national digits', () => {
  assert.ok(P.e164Valid('+351912345678'));
  assert.ok(!P.e164Valid('+35191234567'));
});

test('E.164: a leading zero after the plus sign is not valid', () => {
  assert.ok(!P.e164Valid('+034600123456'));
});

test('E.164: NANP needs ten national digits, a non-zero area and a non-zero exchange', () => {
  assert.ok(P.e164Valid('+12025550143'));
  assert.ok(!P.e164Valid('+10255550143'));
  assert.ok(!P.e164Valid('+11025550143'));
  assert.ok(!P.e164Valid('+12020050143'));
  assert.ok(!P.e164Valid('+1202555014'));
  assert.ok(!P.e164Valid('+120255501432'));
});

test('E.164: a run of consecutive digits is not valid', () => {
  assert.ok(!P.e164Valid('+491234567890'));
  assert.ok(!P.e164Valid('+490123456789'));
  assert.ok(!P.e164Valid('+499876543210'));
});

test('E.164: unknown country codes use the 10 to 15 digit range', () => {
  assert.ok(P.e164Valid('+2345678901'));
  assert.ok(!P.e164Valid('+234567890'));
  assert.ok(P.e164Valid('+234567890123456'));
  assert.ok(!P.e164Valid('+2345678901234567'));
});

/* ---- Phone shapes through findPii ---- */

test('phone: a separated form whose groups read as a date is not a phone number', () => {
  assert.ok(!piiTypes('on +49 2024-11-20 it', {}).includes('PHONE'));
});

test('phone: a separated form shaped like a dotted address is not a phone number', () => {
  assert.ok(!piiTypes('host +49.123.456.789 up', {}).includes('PHONE'));
});

test('phone: a compact NANP number is reported', () => {
  assert.ok(piiTypes('call +12025550143 now', {}).includes('PHONE'));
});

test('phone: a space-separated number with a known country code is reported, span is the number', () => {
  const text = 'call +34 600 123 456 now';
  const spans = P.findPii(text, {}).filter((s) => s.type === 'PHONE');
  assert.equal(spans.length, 1);
  assert.equal(text.slice(spans[0].start, spans[0].end), '+34 600 123 456');
});

test('phone: a run of consecutive digits inside a country number is not a phone number', () => {
  assert.ok(!piiTypes('id +491234567890 end', {}).includes('PHONE'));
  assert.ok(!piiTypes('id +490123456789 end', {}).includes('PHONE'));
});

/* ---- findPii options and spans ---- */

test('findPii: empty or missing text gives no spans', () => {
  assert.deepStrictEqual(P.findPii('', {}), []);
  assert.deepStrictEqual(P.findPii(null, {}), []);
});

test('findPii: spans carry the type and source pii', () => {
  const spans = P.findPii('call +34 600 123 456 now', {});
  assert.deepStrictEqual(spans.map((s) => [s.type, s.source]), [['PHONE', 'pii']]);
});

test('findPii: a pii option set to false turns only that type off', () => {
  const found = piiTypes('call +34 600 123 456 or mail ops@example.com', { pii: { phone: false } });
  assert.ok(!found.includes('PHONE'));
  assert.ok(found.includes('EMAIL'));
});

test('findPii: without a pii object, or with one that is not an object, the defaults apply', () => {
  const text = 'call +34 600 123 456';
  assert.ok(piiTypes(text).includes('PHONE'));
  assert.ok(piiTypes(text, { pii: 'yes' }).includes('PHONE'));
  assert.ok(piiTypes(text, { pii: null }).includes('PHONE'));
});

test('findPii: ipv4 is off by default and on when asked for', () => {
  const text = 'peer 192.0.0.9 answered';
  assert.ok(!piiTypes(text).includes('IPV4'));
  assert.ok(piiTypes(text, { pii: { ipv4: true } }).includes('IPV4'));
});

test('PII_DEFAULTS: the documented defaults', () => {
  assert.deepStrictEqual(P.PII_DEFAULTS, {
    email: true, phone: true, iban: true, card: true, dni: true, ssn: true,
    ipv4: false, name: true, address: true, username: true,
  });
});

/* ---- Mask boundaries, second round: the length floor and the AND between the two mask conditions ---- */

test('bearer: a 16-character body in full filler is masked, a 15-character one is not', () => {
  // XOX is stripped first, so the masked body is 16 characters long (12 filler, 4 others).
  assert.equal(bearerSpans(XOX + 'x'.repeat(12) + 'Q'.repeat(4)).length, 0);
  assert.equal(bearerSpans(XOX + 'x'.repeat(15)).length, 1);
});

test('bearer: 8 filler of 16 characters is not masked, even with 8 or fewer others', () => {
  assert.equal(bearerSpans(XOX + 'x'.repeat(8) + 'Q'.repeat(8)).length, 1);
});

test('Anthropic key: 30 filler of 40 characters is not masked when there are more than 8 others', () => {
  assert.ok(types(ANT + 'x'.repeat(30) + 'Q'.repeat(10)).includes('ANTHROPIC_KEY'));
});

test('placeholder: a single star or dot is not a placeholder (three are needed)', () => {
  assert.ok(!P.isPlaceholder('*'));
  assert.ok(!P.isPlaceholder('.'));
  assert.ok(P.isPlaceholder('***'));
  assert.ok(P.isPlaceholder('...'));
});

test('bearer: the zn marker tokens are excluded only as whole values', () => {
  assert.equal(bearerSpans('__ZN_LOCAL_API_TOKEN__').length, 0);
  assert.equal(bearerSpans('__ZN_LOCAL_API_TOKEN__Qx9Lm3Pr7Tv2Nb5Wc8').length, 1);
  assert.equal(bearerSpans('Qx9Lm3Pr7Tv2Nb5Wc8__ZN_LOCAL_API_TOKEN__').length, 1);
});

test('bearer: a provider prefix is stripped only at the start of the token', () => {
  assert.equal(bearerSpans('Q' + ANT + 'x'.repeat(24) + 'Q'.repeat(7)).length, 1);
});

/* ---- AWS secret: the context words, the 160-character window and the random-looking test ---- */

test('AWS secret: context words in the usual spellings all count', () => {
  for (const ctx of ['AWS_SECRET_ACCESS_KEY', 'secret access key', 'secret-access-key', 'SecretAccessKey']) {
    assert.deepStrictEqual(awsSecrets(ctx + '=' + AWS_BODY), [AWS_BODY], ctx);
  }
});

test('AWS secret: a secret word alone, or aws alone, is not enough context', () => {
  assert.deepStrictEqual(awsSecrets('secret=' + AWS_BODY), []);
  assert.deepStrictEqual(awsSecrets('aws=' + AWS_BODY), []);
  assert.deepStrictEqual(awsSecrets('aws_key=' + AWS_BODY), []);
});

test('AWS secret: a body that does not look random is not reported, even with the context', () => {
  assert.deepStrictEqual(awsSecrets(AWS_CTX + '=' + 'a'.repeat(40)), []);
  assert.deepStrictEqual(awsSecrets(AWS_CTX + '=' + 'aB3'.repeat(13) + 'a'), []);
});

test('AWS secret: the context must be within 160 characters before the body', () => {
  assert.deepStrictEqual(awsSecrets(AWS_CTX + ' '.repeat(200) + '=' + AWS_BODY), []);
});

test('AWS secret: context that comes after the body does not count', () => {
  assert.deepStrictEqual(awsSecrets(AWS_BODY + ' ' + AWS_CTX), []);
});

test('AWS secret: each context word must be inside the 160-character window on its own', () => {
  assert.deepStrictEqual(awsSecrets('aws ' + ' '.repeat(200) + 'secret ' + AWS_BODY), []);
  assert.deepStrictEqual(awsSecrets('secret ' + ' '.repeat(200) + 'aws ' + AWS_BODY), []);
});

/* ---- Phone: dotted and unknown-country forms ---- */

test('phone: dotted groups of a country number are a phone number when the last group is longer', () => {
  const text = 'call +49.123.456.7809 now';
  const spans = P.findPii(text, {}).filter((s) => s.type === 'PHONE');
  assert.equal(spans.length, 1);
  assert.equal(text.slice(spans[0].start, spans[0].end), '+49.123.456.7809');
});

test('phone: a space before a national number with an unknown country code is not a phone number', () => {
  assert.ok(!piiTypes('sum +99 600123456 total', {}).includes('PHONE'));
});

test('phone: only a year-month-day shape is a date; looser groups stay phone numbers', () => {
  assert.ok(piiTypes('call +49 12-11-2024 now', {}).includes('PHONE'));
  assert.ok(piiTypes('call +49 2024-11-2 now', {}).includes('PHONE'));
});

test('phone: spaced groups with an unknown country code are a phone number', () => {
  assert.ok(piiTypes('call +99 600 123 456 now', {}).includes('PHONE'));
});

test('phone: a dotted address-shaped run is not a phone number', () => {
  assert.ok(!piiTypes('host +49.123.456.789 up', {}).includes('PHONE'));
});

if (require.main === module) run('scrub pattern boundaries');
