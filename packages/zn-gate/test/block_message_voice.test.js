'use strict';

// The text an agent gets when zn blocks a read of a secret file reads as a tool result from the user's own
// security tool, not as an order to the model (OpenCode's free model took the old wording for a prompt injection).

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('../lib/hooks/policy');
const runner = require('../lib/hooks/runner');
const { getAdapter } = require('../lib/agents');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

// Wording that tells the model what to do, which a model can mistake for text hidden in the file.
const ORDER_TO_MODEL = /\b(ask the user|you can read|you must|you should|do not tell|ignore)\b/i;

function setup(t) {
  const home = tempDir(t, 'zn-wording-');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, '.env'), 'API_KEY=sk-test-EXAMPLE-0000000000\n');
  fs.writeFileSync(path.join(home, '.aws', 'credentials'), '[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\n');
  return { home, proj };
}

test('the .env read block says what happened, why and what the user can run, with no order to the model', (t) => {
  const { home, proj } = setup(t);
  const msg = policy.readDenial('.env', { cwd: proj, home });
  assert.match(msg, /^zn: \.env was not read\. It holds plain-text secrets/);
  assert.match(msg, /zn \(the security tool the user installed\)/);
  assert.match(msg, /The user can move them to a local vault by running `[^`]*env shadow \.env` in their own terminal/);
  assert.match(msg, /__ZN_<NAME>__ markers that can be read and used/);
  assert.doesNotMatch(msg, ORDER_TO_MODEL);
  assert.ok(msg.length < 400, 'short: ' + msg.length);
});

test('the credentials read block uses the same voice', (t) => {
  const { home, proj } = setup(t);
  const msg = policy.readDenial(path.join(home, '.aws', 'credentials'), { cwd: proj, home });
  assert.match(msg, /was not read because zn treats it as holding secrets/);
  assert.match(msg, /once the user has stored it by running `[^`]*secret set NAME` in their own terminal/);
  assert.doesNotMatch(msg, ORDER_TO_MODEL);
  assert.doesNotMatch(msg, /AKIAIOSFODNN7EXAMPLE/);
});

test('OpenCode: the error the plugin throws carries that text unchanged', async (t) => {
  const { home, proj } = setup(t);
  const res = await runner.handle(getAdapter('opencode'), { hook: 'tool.execute.before', tool: 'read', cwd: proj, args: { filePath: path.join(proj, '.env') } },
    { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'zn run --', home });
  assert.equal(res.output.action, 'deny');
  assert.match(res.output.message, /^zn: \.env was not read\. It holds plain-text secrets/);
  assert.doesNotMatch(res.output.message, ORDER_TO_MODEL);
});
