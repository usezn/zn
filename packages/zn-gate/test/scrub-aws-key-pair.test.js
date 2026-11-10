'use strict';
// An AWS access key id and the secret access key written next to it are both masked.
// The pair is the AWS documentation example (fake values, allowlisted by path in .gitleaks.toml).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const E = require(path.join(__dirname, '..', 'lib', 'scrub', 'engine'));

const KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

// The minimum of the vault that tokenize() uses: tokens are numbered per type, nothing is stored.
function vault() {
  const byKey = new Map();
  let n = 0;
  return {
    async mapToken(project, type, value) {
      const k = project + '\0' + type + '\0' + value;
      if (!byKey.has(k)) byKey.set(k, '__ZN_' + type + '_' + (++n) + '__');
      return byKey.get(k);
    },
    async resolve() { return null; },
    async maskInfo() { return { names: [], longest: 0, count: 0 }; },
    async maskSpans(project, texts) { return texts.map(() => []); },
    async audit() {},
    async setSecret() {}, async listSecrets() { return []; }, async removeSecret() {},
  };
}

const ctx = () => ({ project: '/work/app', agent: 'test', tool: 'Read', destination: 'assistant', vault: vault(), env: {}, exactFiles: false });

test('the key id and the secret on the next line of a credentials file are both masked', async () => {
  const text = 'aws_access_key_id = ' + KEY_ID + '\naws_secret_access_key = ' + SECRET + '\n';
  const r = await E.tokenize(text, ctx());
  assert.ok(!r.text.includes(KEY_ID), 'key id must not survive');
  assert.ok(!r.text.includes(SECRET), 'secret must not survive');
  const types = r.replaced.map((x) => x.type);
  assert.ok(types.includes('AWS_KEY'), 'key id is replaced: ' + types);
  assert.ok(types.includes('AWS_SECRET'), 'secret is replaced: ' + types);
});

test('the key id and the labelled secret on one line are both masked', async () => {
  const text = 'AWS key ' + KEY_ID + ' secret ' + SECRET + '\n';
  const r = await E.tokenize(text, ctx());
  assert.ok(!r.text.includes(KEY_ID), 'key id must not survive');
  assert.ok(!r.text.includes(SECRET), 'secret must not survive');
  const types = r.replaced.map((x) => x.type);
  assert.ok(types.includes('AWS_KEY') && types.includes('AWS_SECRET'), types.join(','));
});

test('a labelled secret written straight after the key id is masked on its own', async () => {
  const text = 'AWS_SECRET_ACCESS_KEY="' + SECRET + '"' + KEY_ID + '\n';
  const r = await E.tokenize(text, ctx());
  assert.ok(!r.text.includes(KEY_ID), 'key id must not survive');
  assert.ok(!r.text.includes(SECRET), 'secret must not survive');
});
