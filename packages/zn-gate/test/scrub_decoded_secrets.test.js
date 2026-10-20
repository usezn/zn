'use strict';
// Secrets inside base64, inside JSON \uXXXX escapes and assembled by simple shell
// expansions are redacted; ordinary base64 and escapes without a secret are not.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const rules = require('../lib/rules');

// Fictitious GitHub token: "ghp_" + 36 characters.
const KEY = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const AWS = 'AKIAIOSFODNN7EXAMPLE';
const escape = (s) => [...s].map((c) => '\\u00' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
const redact = (t) => rules.redactSecrets(t).sanitized;

test('a token written as JSON \\u00XX escapes is redacted whole', () => {
  const text = '{"token":"' + escape(KEY) + '","n":1}';
  const out = redact(text);
  assert.match(out, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.ok(!out.includes('\\u00'), out);
  assert.ok(out.startsWith('{"token":"') && out.endsWith('","n":1}'), out);
});

test('JSON escapes without a secret stay unchanged', () => {
  const text = '{"msg":"' + escape('hello world, nothing here') + '","q":"\\u00e9\\n"}';
  assert.equal(redact(text), text);
});

test('a secret inside base64 is redacted and the run is replaced', () => {
  const b64 = Buffer.from('config: token ' + KEY + ' end').toString('base64');
  const out = redact('data: ' + b64 + ' done');
  assert.equal(out, 'data: [REDACTED_GITHUB_TOKEN] done');
});

test('a secret inside base64 wrapped at 76 characters is redacted', () => {
  const b64 = Buffer.from('AWS_ACCESS_KEY_ID=' + AWS + '\nregion=us-east-1\n' + 'x'.repeat(40)).toString('base64');
  const wrapped = b64.match(/.{1,76}/g).join('\n');
  const out = redact('-----\n' + wrapped + '\n-----');
  assert.ok(!out.includes(b64.slice(0, 20)), out);
  assert.match(out, /\[REDACTED_AWS_KEY\]/);
  assert.ok(out.endsWith('\n-----'), out);
});

test('ordinary base64, hashes and binary data stay unchanged', () => {
  const image = crypto.randomBytes(300).toString('base64');
  const text = 'img: ' + image + '\nsha: ' + 'a'.repeat(64) + '\ntext: ' + Buffer.from('just a plain sentence about nothing').toString('base64');
  assert.equal(redact(text), text);
});

test('a secret assembled by a shell variable expansion is redacted', () => {
  const out = redact('A=AKIA; echo "$A"IOSFODNN7EXAMPLE');
  assert.ok(!out.includes('IOSFODNN7EXAMPLE'), out);
  assert.match(out, /\[REDACTED_AWS_KEY\]/);
  const two = redact('A=ghp_a1B2c3D4e5F6g7H8; B=i9J0k1L2m3N4o5P6q7R8; echo ${A}$B');
  assert.ok(two.endsWith('echo [REDACTED_GITHUB_TOKEN]'), two);
  assert.match(two, /\[REDACTED_GITHUB_TOKEN\]/);
});

test('shell variables without a secret stay unchanged', () => {
  const text = 'DIR=/opt/app; NAME=build; echo "$DIR"/out "${NAME}"-1 $UNSET';
  assert.equal(redact(text), text);
});
