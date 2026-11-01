'use strict';

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SECRETS_TOOL_NAMES, isSecretsToolName } = require('../lib/broker/secrets-tools');
const { TOOLS } = require('../lib/broker/mcp');

test('the shared list is exactly the tools the secrets server exposes', () => {
  assert.deepEqual([...SECRETS_TOOL_NAMES].sort(), TOOLS.map((t) => t.name).sort());
});

test('only an exact tool name counts', () => {
  for (const name of SECRETS_TOOL_NAMES) assert.ok(isSecretsToolName(name), name);
  for (const name of ['_secrets_list', '_secrets_http_request', 'x__secrets_list', 'secrets_list_', 'SECRETS_LIST', '', null, undefined, 1]) {
    assert.equal(isSecretsToolName(name), false, String(name));
  }
});
