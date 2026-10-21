'use strict';

process.env.ZN_STATS = 'off';

// Codex has no fail-closed setting: a hook that times out, crashes or prints nothing
// readable lets the tool call run. These tests spawn the real hook command and check that
// zn answers with Codex's deny shape and exit code 2 itself. The ZN_TEST_HOOK_* variables
// work only with ZN_TEST_HOOK_FAULTS=1 and can only make the hook fail or wait.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { tempDir } = require('./helpers/tmp');
const { HOOK_TIMEOUT_S } = require('../lib/agents/codex');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

function run(t, agent, payload, fault) {
  const home = tempDir(t, 'zn-fc-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off' };
  if (fault) {
    env.ZN_TEST_HOOK_FAULTS = '1';
    Object.assign(env, fault);
  }
  const started = Date.now();
  const r = spawnSync(process.execPath, [RUNNER, agent], { input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 20000 });
  return { ...r, ms: Date.now() - started };
}

function codexPayload(t, event, extra) {
  const cwd = tempDir(t, 'zn-fc-proj-');
  return { session_id: 's', transcript_path: path.join(cwd, 't'), cwd, hook_event_name: event, model: 'm', ...extra };
}
const bash = (t, command) => codexPayload(t, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'u', tool_input: { command } });

function assertCodexDeny(r, event) {
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout); // stdout is nothing but this JSON
  if (event === 'PreToolUse') assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  else if (event === 'PermissionRequest') assert.equal(out.hookSpecificOutput.decision.behavior, 'deny');
  else assert.equal(out.decision, 'block');
  assert.ok(!/\bat .*\.js:\d+/.test(r.stdout), 'no stack trace on stdout');
}

const EVENTS = [
  ['PreToolUse', (t) => bash(t, 'echo hi')],
  ['PermissionRequest', (t) => codexPayload(t, 'PermissionRequest', { tool_name: 'Bash', tool_use_id: 'u', tool_input: { command: 'echo hi' } })],
  ['UserPromptSubmit', (t) => codexPayload(t, 'UserPromptSubmit', { prompt: 'hello', turn_id: 'x' })],
];

test('the watchdog fires before the timeout Codex is given', () => {
  assert.ok(HOOK_TIMEOUT_S >= 10);
});

for (const [event, mk] of EVENTS) {
  test('codex ' + event + ': a hung check is answered with deny and exit 2 before the deadline', (t) => {
    const r = run(t, 'codex', mk(t), { ZN_TEST_HOOK_FAULT: 'hang', ZN_TEST_HOOK_HANG_MS: '30000', ZN_TEST_HOOK_DEADLINE_MS: '800' });
    assertCodexDeny(r, event);
    assert.ok(r.ms < 10000, 'answered in ' + r.ms + ' ms');
    assert.match(r.stdout, /could not finish checking this in time/);
  });

  test('codex ' + event + ': an error thrown by the check is deny, exit 2, JSON only', (t) => {
    assertCodexDeny(run(t, 'codex', mk(t), { ZN_TEST_HOOK_FAULT: 'throw' }), event);
  });

  test('codex ' + event + ': an uncaught exception is deny, exit 2, JSON only', (t) => {
    assertCodexDeny(run(t, 'codex', mk(t), { ZN_TEST_HOOK_FAULT: 'crash', ZN_TEST_HOOK_HANG_MS: '5000' }), event);
  });

  test('codex ' + event + ': an unhandled rejection is deny, exit 2, JSON only', (t) => {
    assertCodexDeny(run(t, 'codex', mk(t), { ZN_TEST_HOOK_FAULT: 'reject', ZN_TEST_HOOK_HANG_MS: '5000' }), event);
  });
}

test('codex: the test variables do nothing without ZN_TEST_HOOK_FAULTS=1', (t) => {
  const home = tempDir(t, 'zn-fc-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off', ZN_TEST_HOOK_FAULT: 'throw', ZN_TEST_HOOK_DEADLINE_MS: '1' };
  delete env.ZN_TEST_HOOK_FAULTS;
  const r = spawnSync(process.execPath, [RUNNER, 'codex'], { input: JSON.stringify(bash(t, 'echo hi')), encoding: 'utf8', env });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('codex: a normal allow is unchanged (exit 0, no output)', (t) => {
  const r = run(t, 'codex', bash(t, 'echo hi'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('codex: a normal block is unchanged (deny JSON, exit 0)', (t) => {
  const p = bash(t, 'cat ~/.aws/credentials');
  const r = run(t, 'codex', p);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('codex: events that cannot block keep their behaviour with a forced error', (t) => {
  const p = codexPayload(t, 'SessionStart', { source: 'startup' });
  const r = run(t, 'codex', p, { ZN_TEST_HOOK_FAULT: 'throw' });
  assert.equal(r.status, 0, r.stderr);
});

test('claude-code: a forced error keeps today\'s behaviour (deny JSON, exit 0)', (t) => {
  const cwd = tempDir(t, 'zn-fc-proj-');
  const p = { session_id: 's', transcript_path: path.join(cwd, 't'), cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } };
  const r = run(t, 'claude-code', p, { ZN_TEST_HOOK_FAULT: 'throw' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
