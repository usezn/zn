'use strict';

// Secret-named keys written in lower case, mixed case, dotted or dashed form
// (openai_api_key=, my.app.db.password=, github-token=) are redacted in prompts
// and in tool output, like their upper-case forms. A short, low-entropy,
// placeholder or reference value is kept. The same fixture is read by the Python
// redact_secrets (tests/test_named_key_values.py). Fake values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../lib/scrub/engine');

const FIXTURE = path.join(__dirname, 'fixtures', 'scrub_named_key_parity.json');

function memoryVault() {
  const byKey = new Map();
  const counters = new Map();
  return {
    async mapToken(project, type, value) {
      const k = type + '\0' + value;
      if (!byKey.has(k)) {
        const n = (counters.get(type) || 0) + 1;
        counters.set(type, n);
        byKey.set(k, '__ZN_' + type + '_' + n + '__');
      }
      return byKey.get(k);
    },
    async exactValues() { return []; },
    async audit() {},
  };
}

const ctx = (tool, destination) => ({ project: '/work/app', agent: 'test', tool, destination, vault: memoryVault(), env: {}, exactFiles: false, pii: false });
const redact = async (text, tool = 'Read', destination = 'assistant') => (await E.tokenize(text, ctx(tool, destination))).text;

test('shared fixture with the Python redact_secrets ({S} is one replaced secret)', async () => {
  const cases = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).cases;
  assert.ok(cases.length >= 30);
  for (const c of cases) {
    assert.equal(await redact(c.input), c.output.split('{S}').join('__ZN_SECRET_1__'), c.name);
  }
});

test('the same keys are redacted in a prompt and in tool output', async () => {
  const text = 'my.app.db.password=Zx9fQ2mK7vLp3Rt8\nopenai_api_key=Q8w3Er7Ty2Ui9Op4As';
  for (const [tool, destination] of [['Read', 'assistant'], ['Bash', 'assistant'], ['UserPromptSubmit', 'model']]) {
    const out = await redact(text, tool, destination);
    assert.ok(!out.includes('Zx9fQ2mK7vLp3Rt8') && !out.includes('Q8w3Er7Ty2Ui9Op4As'), tool + ': ' + out);
    assert.ok(out.includes('my.app.db.password=') && out.includes('openai_api_key='), tool);
  }
});

test('a long line of dotted words with no secret key is left alone', async () => {
  const text = ('a.b.c.d-e.f_g=' + 'x'.repeat(10) + '\n').repeat(2000);
  assert.equal(await redact(text), text);
});
