'use strict';

process.env.ZN_STATS = 'off';

// Codex PostToolUse: another tool's hook can change a command after zn's PreToolUse looked at it, and
// PostToolUse carries the command that really ran. zn checks that command too: when it is one zn blocks,
// the output is withheld. Values are obvious fakes.

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

function postEvent(cwd, command, toolResponse) {
  return {
    session_id: 's', transcript_path: '/t', cwd, hook_event_name: 'PostToolUse', model: 'm', turn_id: 't1',
    tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command }, tool_response: toolResponse,
  };
}

function run(t, command, toolResponse) {
  const home = tempDir(t, 'zn-codex-rewrite-');
  const cwd = tempDir(t, 'zn-codex-rewrite-cwd-');
  fs.writeFileSync(path.join(cwd, '.env'), 'EXAMPLE_TOKEN=not-a-real-value\n');
  return runner.handle(codex, postEvent(cwd, command, toolResponse), {
    engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home,
  });
}

test('codex PostToolUse: a command zn blocks, run after another hook changed it, has its output withheld', async (t) => {
  const r = await run(t, 'cat .env', 'EXAMPLE_TOKEN=not-a-real-value');
  assert.equal(r.output.decision, 'block');
  assert.match(r.output.reason, /another tool changed this command/i);
  assert.match(r.output.reason, /hid its output/);
  assert.match(r.output.reason, /other Codex hooks/);
  assert.ok(!/was not read/.test(r.output.reason));
  assert.ok(!r.output.reason.includes('not-a-real-value'));
});

test('codex PostToolUse: an ordinary command is left alone', async (t) => {
  const r = await run(t, 'echo hello', 'hello');
  assert.equal(r.output, null);
});
