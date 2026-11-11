'use strict';

// A Supabase service-role key is a JWT. When it is assigned to a variable, the
// scrubber masks the value and keeps the variable name, so the name still tells
// the reader what the secret was. The key is built at run time from three
// base64url parts: fake, never real.

const test = require('node:test');
const assert = require('node:assert/strict');
const { findPatterns } = require('../lib/scrub/patterns');
const { redactSecrets } = require('../lib/rules');

const NAME = 'SUPABASE_SERVICE_ROLE_KEY';
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const fakeKey = () => [
  b64url({ alg: 'HS256', typ: 'JWT' }),
  b64url({ iss: 'supabase', role: 'service_role', iat: 1700000000 }),
  Buffer.from('zn-test-fake-signature-0001').toString('base64url'),
].join('.');

test('a Supabase service-role key is masked in an assignment and the name is kept', () => {
  const k = fakeKey();
  const out = redactSecrets(NAME + '=' + k).sanitized;
  assert.equal(out, NAME + '=[REDACTED_JWT]');
  assert.ok(!out.includes(k));
});

test('the same key is masked in an export, a quoted value and free text', () => {
  const k = fakeKey();
  assert.equal(redactSecrets('export ' + NAME + '="' + k + '"').sanitized, 'export ' + NAME + '="[REDACTED_JWT]"');
  assert.equal(redactSecrets('the key is ' + k + ' here').sanitized, 'the key is [REDACTED_JWT] here');
});

test('the scrubber finds the whole key as a JWT span', () => {
  const k = fakeKey();
  const text = NAME + '=' + k;
  const at = text.indexOf(k);
  assert.ok(
    findPatterns(text).some((s) => s.type === 'JWT' && s.start <= at && s.end >= at + k.length),
    'no JWT span covers the key'
  );
});
