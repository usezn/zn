'use strict';

process.env.ZN_STATS = 'off';

// A blocked read of a fictional .env, sent to the real hook process of every
// adapter in the registry. All eight answer a normal deny with one JSON value
// on stdout and exit code 0 (exit 2 is only used when the hook itself fails,
// see hooks_codex_fail_closed and the per-agent tests). The test pins, per
// agent, the field names of the deny shape and that stdout holds nothing else.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { listAdapters } = require('../lib/agents');
const { AGENTS } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

// Per agent: the exact top-level keys of the deny answer, and where the decision and the reason are.
const SHAPES = {
  'claude-code': { keys: ['hookSpecificOutput'], decision: (o) => o.hookSpecificOutput.permissionDecision, reason: (o) => o.hookSpecificOutput.permissionDecisionReason, want: 'deny' },
  codex: { keys: ['hookSpecificOutput'], decision: (o) => o.hookSpecificOutput.permissionDecision, reason: (o) => o.hookSpecificOutput.permissionDecisionReason, want: 'deny' },
  zcode: { keys: ['hookSpecificOutput'], decision: (o) => o.hookSpecificOutput.permissionDecision, reason: (o) => o.hookSpecificOutput.permissionDecisionReason, want: 'deny' },
  cursor: { keys: ['permission', 'user_message'], decision: (o) => o.permission, reason: (o) => o.user_message, want: 'deny' },
  opencode: { keys: ['action', 'message'], decision: (o) => o.action, reason: (o) => o.message, want: 'deny' },
  antigravity: { keys: ['decision', 'reason'], decision: (o) => o.decision, reason: (o) => o.reason, want: 'deny' },
  gemini: { keys: ['decision', 'reason'], decision: (o) => o.decision, reason: (o) => o.reason, want: 'deny' },
  copilot: { keys: ['permissionDecision', 'permissionDecisionReason'], decision: (o) => o.permissionDecision, reason: (o) => o.permissionDecisionReason, want: 'deny' },
};

test('every adapter in the registry has a deny shape here and a request in zn check', () => {
  const ids = listAdapters().sort();
  assert.equal(ids.length, 8);
  assert.deepEqual(Object.keys(SHAPES).sort(), ids);
  assert.deepEqual(AGENTS.map((a) => a.id).sort(), ids);
});

for (const spec of AGENTS) {
  test(spec.id + ': a blocked read of .env is answered with one JSON deny value on stdout and exit code 0', (t) => {
    const dir = tempDir(t, 'zn-denyjson-');
    const home = tempDir(t, 'zn-denyjson-home-');
    spawnSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'ZN_CHECK_EXAMPLE_KEY=zn-check-fake-value-not-a-real-key\n');
    const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off' };
    delete env.ZN_TEST_HOOK_FAULTS;
    const r = spawnSync(process.execPath, [RUNNER, spec.id], { input: JSON.stringify(spec.request(dir, file)), encoding: 'utf8', env, timeout: 20000 });
    assert.equal(r.error, undefined);
    assert.equal(r.status, 0, 'exit code: ' + r.stderr);
    // Exactly one JSON value: the whole of stdout parses, and re-serialising gives it back.
    const out = JSON.parse(r.stdout);
    assert.equal(JSON.stringify(out), r.stdout, 'no extra text around the JSON');
    const shape = SHAPES[spec.id];
    assert.deepEqual(Object.keys(out).sort(), shape.keys);
    assert.equal(shape.decision(out), shape.want);
    const reason = shape.reason(out);
    assert.ok(typeof reason === 'string' && reason.length > 10, 'a reason for the agent');
    assert.ok(!reason.includes('fake-value-not-a-real-key'), 'the reason does not echo the file content');
    assert.ok(!/\bat .*\.js:\d+/.test(r.stdout), 'no stack trace on stdout');
  });
}
