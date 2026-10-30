'use strict';

// The Rust gateway (src/prompt_guard/mod.rs, src/scrubber/mod.rs) says it uses the same override grammar,
// the same rule names and the same card, SSN and phone checks as this package. Each table below has a
// fixture that both sides read: this test checks the Node.js side against it, and a cargo test checks the
// Rust side (prompt_guard_tables.json and scrub_validator_cases.json in test/fixtures).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { INJECTION_RULES } = require('../lib/rules');
const patterns = require('../lib/scrub/patterns');

const FIXTURES = path.join(__dirname, 'fixtures');
const tables = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'prompt_guard_tables.json'), 'utf8'));
const validators = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'scrub_validator_cases.json'), 'utf8'));
const rulesSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'rules.js'), 'utf8');

// An entry ending in "?" stands for the word and the word without its last letter.
function expand(list) {
  const out = new Set();
  for (const w of list) {
    if (w.endsWith('?')) {
      out.add(w.slice(0, -2));
      out.add(w.slice(0, -1));
    } else {
      out.add(w);
    }
  }
  return [...out].sort();
}

// The words of the first (?:a|b|c) group of a string constant of rules.js.
function sourceWords(name) {
  const decl = new RegExp(`const ${name} =\\s*('(?:[^'\\\\]|\\\\.)*');`).exec(rulesSource);
  assert.ok(decl, `${name} not found in rules.js`);
  const source = vm.runInNewContext(decl[1]);
  const group = /\(\?:([A-Za-z|?]+)\)/.exec(source);
  assert.ok(group, `${name} has no word group`);
  return expand(group[1].split('|'));
}

for (const [key, constName] of [
  ['quantifier', 'OVERRIDE_QUANTIFIER_SOURCE'],
  ['determiner', 'OVERRIDE_DETERMINER_SOURCE'],
  ['qualifier', 'OVERRIDE_QUALIFIER_SOURCE'],
  ['noun', 'OVERRIDE_NOUN_SOURCE'],
]) {
  test(`override grammar: ${key} words equal the shared fixture`, () => {
    assert.deepEqual(sourceWords(constName), expand(tables.override_grammar[key]));
  });
}

test('forget rule: object and data-noun words equal the shared fixture', () => {
  const src = INJECTION_RULES.find((r) => r.id === 'pi:forget').pattern.source;
  const obj = /forget\\s\+\(\?:about\\s\+\)\?\(\?:([A-Za-z|]+)\)/.exec(src);
  const data = /\(\?:the\\s\+\)\?\(\?:([A-Za-z|?]+)\)/.exec(src);
  assert.ok(obj && data, 'pi:forget source shape changed');
  assert.deepEqual(expand(obj[1].split('|')), expand(tables.forget_rule.object));
  assert.deepEqual(expand(data[1].split('|')), expand(tables.forget_rule.data_noun_not_blocked));
});

test('injection rule ids equal the shared fixture', () => {
  assert.deepEqual(INJECTION_RULES.map((r) => r.id), tables.node_rule_ids);
  for (const id of tables.rust_only_rule_ids) assert.ok(!tables.node_rule_ids.includes(id), id);
});

test('card, SSN, E.164 and Luhn validators give the fixture result for every case', () => {
  const fns = { luhn: patterns.luhnValid, card: patterns.cardValid, ssn: patterns.ssnValid, e164: patterns.e164Valid };
  assert.ok(validators.cases.length > 300);
  for (const c of validators.cases) {
    assert.equal(fns[c.fn](c.input), c.valid, `${c.fn} ${JSON.stringify(c.input)}`);
  }
});
