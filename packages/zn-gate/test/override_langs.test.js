'use strict';

// Spanish, French, German and Portuguese override rules. Like the English
// ones, an override verb only counts when it names a target (the previous
// instructions, the rules, the system prompt...). Ordinary sentences with the
// same verbs ("ignora el error", "vergiss den Termin nicht") stay allowed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../lib/rules');
const CASES = require('./fixtures/override_langs_cases.json');

for (const [lang, c] of Object.entries(CASES)) {
  test(`${lang}: canonical override phrases are blocked by ${c.rule}`, () => {
    for (const text of c.attacks) {
      const res = evaluate(text);
      assert.equal(res.verdict, 'block', text);
      assert.equal(res.rule, c.rule, text);
    }
  });

  test(`${lang}: ordinary sentences with the same verbs stay allowed`, () => {
    for (const text of c.benign) {
      const res = evaluate(text);
      assert.equal(res.verdict, 'allow', `${text} (${res.rule})`);
    }
  });

  test(`${lang}: the phrase is blocked inside a longer text`, () => {
    for (const text of c.attacks) {
      const res = evaluate(`Notes for the build.\nThanks for your help.\n${text}\nEnd of file.`);
      assert.equal(res.verdict, 'block', text);
    }
  });
}
