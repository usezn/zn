'use strict';

// The hook settings in ~/.zn/config.json come from ZN_HOME when it is set, as they do for every other reader of
// config.json (stats, cloud key, pins). Without ZN_HOME they come from <home>/.zn, the folder the caller passes.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runner = require('../lib/hooks/runner');
const { getAdapter } = require('../lib/agents');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const claude = getAdapter('claude-code');

function writeConfig(dir, config) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
}

// The decision for a Write to CLAUDE.md, which agentInstructionWrites governs ("allow" when the hook has no answer).
async function writeDecision(home, proj) {
  const raw = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: path.join(proj, 'CLAUDE.md'), content: 'Example instruction.' },
    cwd: proj,
    session_id: 's',
  };
  const res = await runner.handle(claude, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'zn run --', home });
  const o = res.output && res.output.hookSpecificOutput;
  return o ? o.permissionDecision : 'allow';
}

// Runs fn with ZN_HOME set to value, or unset when value is undefined; the environment is restored afterwards.
async function withZnHome(value, fn) {
  const before = process.env.ZN_HOME;
  if (value === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = before;
  }
}

test('with ZN_HOME set, the hook reads its settings from ZN_HOME/config.json, not from <home>/.zn', async (t) => {
  const home = tempDir(t, 'zn-config-home-');
  const znHome = tempDir(t, 'zn-config-zn-home-');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  writeConfig(znHome, { hooks: { agentInstructionWrites: 'deny' } });
  writeConfig(path.join(home, '.zn'), { hooks: { agentInstructionWrites: 'off' } });

  assert.equal(await withZnHome(znHome, () => writeDecision(home, proj)), 'deny');
});

test('without ZN_HOME the hook reads its settings from <home>/.zn', async (t) => {
  const home = tempDir(t, 'zn-config-home-');
  const znHome = tempDir(t, 'zn-config-zn-home-');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  writeConfig(path.join(home, '.zn'), { hooks: { agentInstructionWrites: 'deny' } });
  // A different value in another folder that is not ZN_HOME must not be read.
  writeConfig(znHome, { hooks: { agentInstructionWrites: 'off' } });

  assert.equal(await withZnHome(undefined, () => writeDecision(home, proj)), 'deny');
});
