'use strict';
// zn-gate stats: these tests must never count into the real ~/.zn/stats.json.
process.env.ZN_STATS = 'off';

// A git that never answers (a network drive, a locked index) must not hold the hook: spawnSync blocks the whole process, so
// the hook has to give up on git by itself and answer with the safe result (the secret stays out of the file).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { generateAll } = require('./fixtures/fake_secrets');
const { tempDir } = require('./helpers/tmp');

const FAKE = generateAll(4242, { perType: 1, piiPerType: 1 });
const AWS = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;
const PREFIX = 'ZN_AGENT=claude-code "node" "cli.js" run --';

test('a hung git does not stop the Write hook: it answers in time and keeps the secret out of the file', { skip: process.platform === 'win32' }, async (t) => {
  const shims = tempDir(t, 'zn-git-hang-');
  const project = tempDir(t, 'zn-hook-project-');
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; });
  // A git on the PATH that sleeps 30 s, so only the timeout can end the call.
  fs.writeFileSync(path.join(shims, 'git'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  process.env.PATH = shims + path.delimiter + oldPath;

  const vault = createFakeVault();
  const token = await vault.mapToken(project, 'AWS_KEY', AWS);
  const raw = {
    session_id: 'abc123',
    cwd: project,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: path.join(project, 'config.js'), content: 'const k = "' + token + '";' },
    tool_use_id: 'toolu_02',
  };
  const started = Date.now();
  const res = await runner.handle(getAdapter('claude-code'), raw, { engine: fakeEngine, vault, failMode: 'open', znRunPrefix: PREFIX });
  const took = Date.now() - started;
  assert.ok(took < 5000, 'the hook took ' + took + ' ms');
  // Unknown git state counts as tracked: the token stays in the file, the value is never written.
  assert.ok(!JSON.stringify(res.output || {}).includes(AWS));
});
