'use strict';
// A Terraform Cloud token in a credentials block is masked, and the host name
// around it is kept. The token is built at run time from fake parts. Fake values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/scrub/engine');
const { findPatterns } = require('../lib/scrub/patterns');

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

const ctx = () => ({ project: '/work/app', agent: 'test', tool: 'Read', destination: 'assistant', vault: memoryVault(), env: {}, exactFiles: false, pii: false });
const redact = async (text) => (await E.tokenize(text, ctx())).text;

// Fake Terraform Cloud token: 14 lowercase characters, ".atlasv1.", then 64 URL-safe characters.
const ALPHA = 'Qa7Zt3Lm9Pw2Ny5Rb8Vx1Cd4Fg6Hj0Ks-_';
const FAKE_PREFIX = ['qa7zt3', 'lm9pw2', 'ny'].join('');
const FAKE_BODY = Array.from({ length: 64 }, (_, i) => ALPHA[(i * 7 + 3) % ALPHA.length]).join('');
const FAKE_TOKEN = FAKE_PREFIX + '.atlasv1.' + FAKE_BODY;
const HOST = 'app.terraform.io';

test('a Terraform Cloud token in an HCL credentials block is masked and the host is kept', async () => {
  const text = 'credentials "' + HOST + '" {\n  token = "' + FAKE_TOKEN + '"\n}\n';
  const out = await redact(text);
  assert.ok(!out.includes(FAKE_TOKEN), 'token must not survive: ' + out);
  assert.ok(!out.includes(FAKE_BODY), 'token body must not survive: ' + out);
  assert.ok(out.includes('credentials "' + HOST + '" {'), 'host block header kept: ' + out);
  assert.ok(out.includes('token = "'), 'key kept: ' + out);
});

test('the Terraform Cloud token span covers the token value only', () => {
  const text = 'credentials "' + HOST + '" {\n  token = "' + FAKE_TOKEN + '"\n}\n';
  const hits = findPatterns(text, {}).filter((h) => h.type === 'TERRAFORM_CLOUD_TOKEN');
  assert.equal(hits.length, 1);
  assert.equal(text.slice(hits[0].start, hits[0].end), FAKE_TOKEN);
});
