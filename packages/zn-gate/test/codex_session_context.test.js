'use strict';

// Codex SessionStart and SubagentStart: zn adds a short reminder through
// hookSpecificOutput.additionalContext (shape from openai/codex's generated hook
// schemas). It never blocks and checks nothing. Values are fake.
process.env.ZN_STATS = 'off';

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

const base = { session_id: 's', transcript_path: null, cwd: '/', model: 'm', permission_mode: 'default' };
const start = { ...base, hook_event_name: 'SessionStart', source: 'startup' };
const sub = { ...base, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'default', turn_id: 't' };

const run = (raw) => runner.handle(codex, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'closed' });

for (const [name, raw] of [['SessionStart', start], ['SubagentStart', sub]]) {
  test('codex ' + name + ': a short reminder as additionalContext, in the documented shape', async () => {
    const r = await run(raw);
    assert.deepEqual(Object.keys(r.output), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(r.output.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
    assert.equal(r.output.hookSpecificOutput.hookEventName, name);
    const text = r.output.hookSpecificOutput.additionalContext;
    assert.match(text, /\.env/);
    assert.match(text, /vault/);
    assert.match(text, /run -- /);
    assert.ok(text.length < 400, 'short');
    assert.equal(r.decision.decision, 'allow');
    // Nothing that stops or decides: SessionStart can stop a session with continue:false, zn never does.
    assert.equal(r.output.continue, undefined);
    assert.equal(r.output.decision, undefined);
  });
}

test('codex SessionStart: every source gets the reminder', async () => {
  for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) {
    const r = await run({ ...start, source });
    assert.ok(r.output.hookSpecificOutput.additionalContext, source);
  }
});

test('codex SessionStart: unreadable events still never block', async () => {
  const r = await run({ hook_event_name: 'SessionStart' });
  assert.equal(r.output.hookSpecificOutput.hookEventName, 'SessionStart');
});

test('codex: install registers SessionStart and SubagentStart without a matcher; uninstall removes them', (t) => {
  const home = tempDir(t, 'zn-cx-ss-');
  const env = { CODEX_HOME: path.join(home, '.codex'), ZN_HOME: path.join(home, '.zn') };
  const file = codex.hooksFile({ env });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } }));
  const opts = { env, nodePath: '/usr/bin/node', runnerPath: '/x/lib/hooks/runner.js' };
  codex.install(opts);
  codex.install(opts);
  const hooks = JSON.parse(fs.readFileSync(file, 'utf8')).hooks;
  for (const ev of ['SessionStart', 'SubagentStart']) {
    const ours = hooks[ev].filter((g) => g.hooks.some((h) => /runner\.js|zn-hook-codex\.sh/.test(h.command)));
    assert.equal(ours.length, 1, ev + ' once, idempotent');
    assert.equal(ours[0].matcher, undefined);
  }
  assert.equal(hooks.SessionStart[0].hooks[0].command, 'mine.sh', 'the user\'s own hook stays');
  codex.uninstall({ env });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hooks, { SessionStart: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] });
});
