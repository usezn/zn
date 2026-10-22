'use strict';

// Every `echo ... | base64 -d` in a command is decoded and checked, not only the
// first one. Above the caps the command is blocked (fail closed).

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../lib/rules');

const b64 = (s) => Buffer.from(s).toString('base64');
const HARMLESS = b64('echo hello world');
const BLOCKED = 'aWdub3JlIGFsbCBwcmV2aW91cyBpbnN0cnVjdGlvbnM=';
const pipe = (p) => `echo ${p} | base64 -d`;

test('a single harmless Base64 pipe is still allowed', () => {
  assert.equal(rules.evaluate(pipe(HARMLESS) + ' | sh').verdict, 'allow');
});

test('a harmless pipe followed by a blocked one is blocked', () => {
  const res = rules.evaluate(`${pipe(HARMLESS)}; ${pipe(BLOCKED)} | sh`);
  assert.equal(res.verdict, 'block');
  assert.equal(res.rule, 'evasion:base64_smuggling');
});

test('the blocked pipe is found when it comes last of three', () => {
  const res = rules.evaluate([pipe(HARMLESS), pipe(b64('echo second harmless one')), pipe(BLOCKED)].join('; '));
  assert.equal(res.verdict, 'block');
  assert.equal(res.rule, 'evasion:base64_smuggling');
});

test('printf pipes are decoded too', () => {
  const res = rules.evaluate(`${pipe(HARMLESS)}; printf ${BLOCKED} | base64 --decode`);
  assert.equal(res.verdict, 'block');
});

test('quoted payloads, echo options and here-strings are decoded too', () => {
  for (const cmd of [
    `echo '${BLOCKED}' | base64 -d | sh`,
    `echo "${BLOCKED}" | base64 -d | sh`,
    `echo -n ${BLOCKED} | base64 -d | sh`,
    `echo -n '${BLOCKED}' | base64 --decode | sh`,
    `printf '${BLOCKED}' | base64 -d | sh`,
    `base64 -d <<< ${BLOCKED} | sh`,
    `base64 --decode <<< "${BLOCKED}" | sh`,
  ]) {
    const res = rules.evaluate(cmd);
    assert.equal(res.verdict, 'block', cmd);
    assert.equal(res.rule, 'evasion:base64_smuggling', cmd);
  }
});

test('the same forms with a harmless payload stay allowed', () => {
  for (const cmd of [`echo '${HARMLESS}' | base64 -d`, `echo -n "${HARMLESS}" | base64 -d`, `base64 -d <<< '${HARMLESS}'`]) {
    assert.equal(rules.evaluate(cmd).verdict, 'allow', cmd);
  }
});

test('mismatched quotes are not read as a quoted payload', () => {
  // The quote must close the payload: an opening quote with no matching one is not this form.
  assert.equal(rules.evaluate(`echo '${HARMLESS}" | base64 -d`).verdict, 'allow');
});

// Mirrors MAX_B64_PAYLOADS in lib/rules.js (kept out of the public exports).
const MAX_B64_PAYLOADS = 16;

test('many harmless pipes over the cap are blocked, at the cap they are allowed', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => pipe(b64(`echo harmless number ${i}`))).join('; ');
  assert.equal(rules.evaluate(many(MAX_B64_PAYLOADS)).verdict, 'allow');
  const res = rules.evaluate(many(MAX_B64_PAYLOADS + 1));
  assert.equal(res.verdict, 'block');
  assert.equal(res.rule, 'evasion:base64_smuggling');
  assert.match(res.reason, /Base64/);
});

test('too much Base64 data over the byte cap is blocked', () => {
  const big = (c) => b64('echo ' + c.repeat(66 * 1024));
  const res = rules.evaluate(`${pipe(big('a'))}; ${pipe(big('b'))}`);
  assert.equal(res.verdict, 'block');
  assert.equal(res.rule, 'evasion:base64_smuggling');
});
