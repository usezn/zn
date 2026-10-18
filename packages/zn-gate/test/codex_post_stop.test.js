'use strict';

// zn-gate stats: these tests must never count into the real ~/.zn/stats.json.
process.env.ZN_STATS = 'off';

// Codex PostToolUse with the opt-in hooks.stopTurnOnSecret setting. Values are obvious
// fakes: the AWS documentation example key and a placeholder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const codex = getAdapter('codex');
const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE';

function postEvent(toolResponse) {
  return {
    session_id: 's',
    transcript_path: '/t',
    cwd: '/',
    hook_event_name: 'PostToolUse',
    model: 'm',
    turn_id: 't1',
    tool_name: 'Bash',
    tool_use_id: 'u1',
    tool_input: { command: 'cat config.txt' },
    tool_response: toolResponse,
  };
}

// A fresh home directory, with ~/.zn/config.json holding `config` when given.
function homeWith(t, config) {
  const home = tempDir(t, 'zn-codex-stop-');
  if (config) {
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    fs.writeFileSync(path.join(home, '.zn', 'config.json'), JSON.stringify(config));
  }
  return home;
}

function run(t, toolResponse, config) {
  return runner.handle(codex, postEvent(toolResponse), {
    engine: fakeEngine,
    vault: createFakeVault(),
    failMode: 'open',
    home: homeWith(t, config),
  });
}

const WITH_SECRET = 'aws_access_key_id = ' + FAKE_KEY + '\n';

test('off by default: a secret gets the same block as before, with no stop fields', async (t) => {
  const unset = await run(t, WITH_SECRET);
  assert.deepEqual(Object.keys(unset.output), ['decision', 'reason']);
  assert.equal(unset.output.decision, 'block');
  assert.match(unset.output.reason, /__ZN_/);
  assert.ok(!JSON.stringify(unset.output).includes(FAKE_KEY));

  const explicitOff = await run(t, WITH_SECRET, { hooks: { stopTurnOnSecret: false } });
  assert.equal(JSON.stringify(explicitOff.output), JSON.stringify(unset.output));

  // Only the boolean true turns it on; a string does not.
  const stringTrue = await run(t, WITH_SECRET, { hooks: { stopTurnOnSecret: 'true' } });
  assert.equal(JSON.stringify(stringTrue.output), JSON.stringify(unset.output));
});

test('on with a fake secret: continue false and a stopReason, and the value is still masked', async (t) => {
  const r = await run(t, WITH_SECRET, { hooks: { stopTurnOnSecret: true } });
  assert.equal(r.output.decision, 'block');
  assert.equal(r.output.continue, false);
  assert.equal(typeof r.output.stopReason, 'string');
  assert.match(r.output.stopReason, /^zn stopped this turn/);
  assert.match(r.output.stopReason, /AWS/);
  assert.match(r.output.reason, /__ZN_/);
  const text = JSON.stringify(r.output);
  assert.ok(!text.includes(FAKE_KEY), 'the value must not appear in the output');
});

test('on with benign output: no stop and no output', async (t) => {
  const r = await run(t, 'total 0\nnpm test ok\n', { hooks: { stopTurnOnSecret: true } });
  assert.equal(r.output, null);
});

test('on with a marker only: no stop', async (t) => {
  const r = await run(t, 'aws_access_key_id = __ZN_AWS_KEY_1__\n', { hooks: { stopTurnOnSecret: true } });
  assert.equal(r.output, null);
});
