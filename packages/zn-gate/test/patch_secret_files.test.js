'use strict';

// A Codex or OpenCode patch that touches a secret file is refused (Add, Update and Delete File).
// Fake values only; every path is under a temporary home.

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

const codex = getAdapter('codex');
const opencode = getAdapter('opencode');

function setup(t) {
  const home = tempDir(t, 'zn-patch-secrets-');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, '.env'), 'API_KEY=sk-test-EXAMPLE-0000000000\n');
  fs.writeFileSync(path.join(proj, '.env.local'), 'TOKEN=example-local-value-123\n');
  fs.writeFileSync(path.join(proj, '.env.shadowed'), 'API_KEY=__ZN_API_KEY__\n');
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'hello\n');
  fs.writeFileSync(path.join(home, '.aws', 'credentials'), '[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\n');
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZQ==\n-----END OPENSSH PRIVATE KEY-----\n');
  return { home, proj };
}

const run = (adapter, raw, home) => runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'zn run --', home });
const cx = (proj, patch) => ({ session_id: 's', transcript_path: '/t', cwd: proj, hook_event_name: 'PreToolUse', model: 'm', tool_name: 'apply_patch', tool_input: { command: patch } });
const oc = (proj, patch) => ({ hook: 'tool.execute.before', tool: 'apply_patch', args: { patchText: patch }, cwd: proj });
const denied = (res) => !!res.output && ((res.output.hookSpecificOutput && res.output.hookSpecificOutput.permissionDecision === 'deny') || res.output.action === 'deny');
const reasonOf = (res) => (res.output.hookSpecificOutput ? res.output.hookSpecificOutput.permissionDecisionReason : res.output.message);

function ops(p) {
  return {
    update: '*** Begin Patch\n*** Update File: ' + p + '\n@@\n-a\n+b\n*** End Patch',
    add: '*** Begin Patch\n*** Add File: ' + p + '\n+x=1\n*** End Patch',
    del: '*** Begin Patch\n*** Delete File: ' + p + '\n*** End Patch',
  };
}

for (const [name, adapter, mk] of [['Codex', codex, cx], ['OpenCode', opencode, oc]]) {
  test(name + ': Add, Update and Delete File on a secret file are refused', async (t) => {
    const { home, proj } = setup(t);
    const targets = ['.env', '.env.local', path.join(home, '.aws', 'credentials'), path.join(home, '.ssh', 'id_rsa'), '~/.aws/credentials'];
    for (const target of targets) {
      for (const [op, patch] of Object.entries(ops(target))) {
        const res = await run(adapter, mk(proj, patch), home);
        assert.ok(denied(res), name + ' ' + op + ' ' + target);
        assert.doesNotMatch(reasonOf(res), /sk-test-EXAMPLE|AKIAIOSFODNN7EXAMPLE/);
      }
    }
  });

  test(name + ': one secret file among several in a patch refuses the whole patch', async (t) => {
    const { home, proj } = setup(t);
    const patch = '*** Begin Patch\n*** Update File: notes.txt\n@@\n-hello\n+hi\n*** Delete File: .env\n*** End Patch';
    assert.ok(denied(await run(adapter, mk(proj, patch), home)));
  });

  test(name + ': a benign patch and a shadowed .env are not refused', async (t) => {
    const { home, proj } = setup(t);
    for (const p of ['notes.txt', 'src/new.js', '.env.shadowed', '.env.example']) {
      for (const patch of Object.values(ops(p))) {
        assert.ok(!denied(await run(adapter, mk(proj, patch), home)), name + ' ' + p);
      }
    }
  });
}
