'use strict';
// Shell history through the agent hook: a plain `history` listing is allowed, and wiping the shell history
// (`history -c`) should be blocked. Today the hook policy has no rule for it and allows it, so that case is a todo
// with the gap as its reason.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');

const adapter = require('../lib/agents/claude-code');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

function preTool(command, cwd) {
  return { session_id: 'abc123', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_01' };
}

async function verdict(t, command) {
  const home = tempDir(t, 'zn-history-');
  const out = await runner.handle(adapter, preTool(command, home), { engine: fakeEngine, vault: createFakeVault(), failMode: 'open' });
  return out.decision.decision;
}

test('a plain history listing is allowed, alone and in a pipeline', async (t) => {
  assert.equal(await verdict(t, 'history'), 'allow');
  assert.equal(await verdict(t, 'history | grep docker'), 'allow');
});

test('wiping the shell history with history -c is blocked', { todo: 'product gap: the hook policy has no rule for history -c (nor history -w, -d or HISTFILE changes); it allows them today' }, async (t) => {
  assert.equal(await verdict(t, 'history -c'), 'block');
});
