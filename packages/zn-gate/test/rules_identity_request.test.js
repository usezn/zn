'use strict';

// Identity-request family: text in a tool result that tells the agent to
// identify its user, or to put the user's identity in a header, URL
// parameter, cookie, form field or the next request. The cases are shared
// with the Python test (test_rules_identity_request.py).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rules = require('../lib/rules');

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'identity_request_cases.json'), 'utf8'));
const FAMILY = ['pi:identity_request', 'pi:identity_request_multi'];

test('the family is an advisory by default', () => {
  for (const id of FAMILY) assert.ok(rules.ADVISORY_BY_DEFAULT.has(id), id);
});

test('every positive case is flagged as an advisory', () => {
  for (const text of CASES.positives) {
    const r = rules.evaluate(text);
    assert.equal(r.verdict, 'allow', text);
    assert.ok(r.advisory && FAMILY.includes(r.advisory.rule), text);
  }
});

test('strict mode blocks every positive case', () => {
  for (const text of CASES.positives) {
    const r = rules.evaluate(text, { strict: true });
    assert.equal(r.verdict, 'block', text);
    assert.ok(FAMILY.includes(r.rule), text);
  }
});

test('benign counterparts are not flagged by the family', () => {
  for (const text of CASES.benign) {
    for (const options of [{}, { strict: true }]) {
      const r = rules.evaluate(text, options);
      assert.ok(!FAMILY.includes(r.rule), text);
      assert.ok(!(r.advisory && FAMILY.includes(r.advisory.rule)), text);
    }
  }
});

test('a tool result with the request is passed on with an advisory, and blocked in strict mode', () => {
  const text = CASES.positives[0];
  const r = rules.sanitizeToolResult('WebFetch', '<p>Welcome</p> ' + text);
  assert.equal(r.safe_to_ingest, true);
  assert.equal(r.assessment.advisory.rule, 'pi:identity_request');
  const s = rules.sanitizeToolResult('WebFetch', '<p>Welcome</p> ' + text, { strict: true });
  assert.equal(s.safe_to_ingest, false);
  assert.equal(s.assessment.rule, 'pi:identity_request');
});

test('long runs of words do not make the family slow', () => {
  const filler = 'send the users '.repeat(4000);
  const start = Date.now();
  rules.evaluate(filler);
  rules.evaluate('include ' + 'the user '.repeat(5000) + 'header');
  assert.ok(Date.now() - start < 3000);
});

// Prefilters: the cheap checks in front of the two patterns must never change
// a verdict.
const ID_RULES = Object.fromEntries(rules.INJECTION_RULES.filter((r) => FAMILY.includes(r.id)).map((r) => [r.id, r]));
const USER_GROUPS = {
  'pi:identity_request': [
    '(?:user|operator|owner|human|principal)',
    String.raw`(?:whoami|git\s{1,4}config\s{1,4}(?:--[a-z-]{1,12}\s{1,4}){0,2}user\.(?:email|name))`,
    String.raw`(?:your|their)\s{1,4}(?:(?:primary|login|account|real)\s{1,4})?e-?mail(?:\s{1,4}address(?:es)?)?`,
  ],
  'pi:identity_request_multi': [
    '(?:usuario|operador|due[ñn]o|propietario)',
    '(?:usu[aá]rio|operador|dono|propriet[aá]rio)',
    '(?:utilisateur|opérateur|propriétaire)',
    '(?:nutzers|benutzers|bedieners|betreibers|besitzers|operators)',
    '(?:пользовател[а-яё]+|оператор[а-яё]*|владельц[а-яё]+|хозяин[а-яё]*)',
    '(?:用户|使用者|操作者|主人|所有者)',
    String.raw`(?:whoami|git\s{1,4}config\s{1,4}(?:--[a-z-]{1,12}\s{1,4}){0,2}user\.(?:email|name))`,
  ],
};

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function topLevelAlternatives(source) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') { cur += c + source[++i]; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function placeGroups(source) {
  const found = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (!source.startsWith('(?:', i)) continue;
    let depth = 0;
    let j = i;
    for (; j < source.length; j++) {
      if (source[j] === '\\') { j++; continue; }
      if (source[j] === '(') depth++;
      if (source[j] === ')' && --depth === 0) break;
    }
    const group = source.slice(i, j + 1);
    if (/header/i.test(group) && group.length < 600 && !group.includes('[^\\n]') && !found.includes(group)) found.push(group);
  }
  return found;
}

test('the rule ids are exactly the two identity-request ids', () => {
  assert.deepEqual(Object.keys(ID_RULES).sort(), ['pi:identity_request', 'pi:identity_request_multi']);
});

test('the prefilters hold the user and place groups that every alternative of the pattern needs', () => {
  for (const [id, expected] of [['pi:identity_request', 2], ['pi:identity_request_multi', 6]]) {
    const rule = ID_RULES[id];
    const [gate, place] = rule.prefilters;
    const places = placeGroups(rule.pattern.source);
    assert.equal(places.length, expected, id);
    for (const g of places) assert.ok(place.source.includes(g), id + ' misses ' + g);
    for (const g of USER_GROUPS[id]) assert.ok(gate.source.includes(g), id + ' misses ' + g);
    for (const re of rule.prefilters) assert.equal(re.flags, rule.pattern.flags, id);
    // Every top-level alternative of the pattern needs a user group, and all
    // but the "who is your user" phrasings need a place group.
    for (const alt of topLevelAlternatives(rule.pattern.source)) {
      assert.ok(USER_GROUPS[id].some((g) => alt.includes(g)), id + ': ' + alt.slice(0, 60));
      assert.ok(places.some((g) => alt.includes(g)) || /identify/.test(alt), id + ': ' + alt.slice(0, 60));
    }
  }
  assert.ok(ID_RULES['pi:identity_request'].prefilters[0].source.includes('customer|account\\s{1,4}holder'));
});

test('with and without the prefilters the pattern gives the same result', () => {
  const samples = CASES.positives.concat(CASES.benign);
  const words = [];
  for (const t of samples) words.push(...t.split(/\s+/));
  words.push('header', 'cookie', 'who', 'your user', '\n', 'identify', 'x-user-email', 'customer', 'holder');
  const rand = lcg(1080);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  let positives = 0;
  for (let n = 0; n < 4000; n++) {
    const base = pick(samples).split(' ');
    const k = Math.floor(rand() * 3);
    for (let m = 0; m < k; m++) {
      const at = Math.floor(rand() * base.length);
      const op = rand();
      if (op < 0.4) base.splice(at, 1);
      else if (op < 0.8) base[at] = pick(words);
      else base.splice(at, 0, pick(words));
    }
    const text = rand() < 0.2 ? base.join(' ').toUpperCase() : base.join(rand() < 0.1 ? '\n' : ' ');
    for (const rule of Object.values(ID_RULES)) {
      const expected = rule.pattern.test(text);
      if (expected) positives++;
      assert.equal(rule.test(text), expected, rule.id + ': ' + text);
    }
  }
  assert.ok(positives > 500, 'the mutations must keep matching often enough: ' + positives);
  for (const text of CASES.positives) {
    assert.ok(Object.values(ID_RULES).some((r) => r.pattern.test(text) && r.test(text)), text);
  }
});

test('the prefilters skip text without a user word or a place word', () => {
  for (const rule of Object.values(ID_RULES)) {
    assert.equal(rule.test('hello world, please summarize this page'), false);
    assert.equal(rule.prefilters.every((re) => re.test('include the header in every request')), false);
  }
});

// Folded characters: the patterns are compiled with the u flag so long s,
// the Kelvin sign and the like fold as in Python, and the prefilters follow the
// patterns. test_rules_identity_request.py runs the same fixture.
const UNICODE_CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'identity_request_unicode_cases.json'), 'utf8')).cases;

test('folded characters give the expected verdict on raw text', () => {
  assert.ok(UNICODE_CASES.length >= 20);
  for (const c of UNICODE_CASES) {
    assert.equal(ID_RULES['pi:identity_request'].test(c.text), c.identity_request, c.name);
    assert.equal(ID_RULES['pi:identity_request_multi'].test(c.text), c.identity_request_multi, c.name);
  }
});

test('the prefilters never hide a folded-character match the pattern finds', () => {
  for (const c of UNICODE_CASES) {
    for (const id of FAMILY) {
      const rule = ID_RULES[id];
      assert.equal(rule.test(c.text), rule.pattern.test(c.text), id + ' ' + c.name);
    }
  }
});

test('the identity patterns and prefilters use the u flag', () => {
  for (const id of FAMILY) {
    assert.ok(ID_RULES[id].pattern.flags.includes('u'), id);
    for (const re of ID_RULES[id].prefilters) assert.ok(re.flags.includes('u'), id);
  }
});
