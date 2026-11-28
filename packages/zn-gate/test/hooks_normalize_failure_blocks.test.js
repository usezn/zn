'use strict';

process.env.ZN_STATS = 'off';

// If an adapter's normalize() throws, there is no event to answer: the hook used to print nothing and exit 0,
// which Claude Code, Cursor, Gemini CLI, Copilot CLI and OpenCode read as an allow. These tests spawn the real
// hook with a fault that makes normalize throw and check each agent gets its own block form.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

function run(t, agent, payload, fault) {
  const home = tempDir(t, 'zn-nf-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off' };
  if (fault) Object.assign(env, { ZN_TEST_HOOK_FAULTS: '1', ZN_TEST_HOOK_FAULT: 'normalize' });
  return spawnSync(process.execPath, [RUNNER, agent], { input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 20000 });
}

const cwd = (t) => tempDir(t, 'zn-nf-proj-');
const CASES = {
  'claude-code': (t) => ({ hook_event_name: 'PreToolUse', cwd: cwd(t), tool_name: 'Bash', tool_input: { command: 'echo hi' } }),
  cursor: (t) => ({ hook_event_name: 'beforeShellExecution', cwd: cwd(t), command: 'echo hi' }),
  gemini: (t) => ({ hook_event_name: 'BeforeTool', cwd: cwd(t), tool_name: 'run_shell_command', tool_input: { command: 'echo hi' } }),
  copilot: (t) => ({ hook_event_name: 'PreToolUse', cwd: cwd(t), tool_name: 'bash', tool_input: { command: 'echo hi' } }),
  opencode: (t) => ({ hook: 'tool.execute.before', cwd: cwd(t), tool: 'bash', args: { command: 'echo hi' } }),
  codex: (t) => ({ hook_event_name: 'PreToolUse', cwd: cwd(t), tool_name: 'Bash', tool_input: { command: 'echo hi' } }),
  zcode: (t) => ({ hook_event_name: 'PreToolUse', cwd: cwd(t), tool_name: 'Bash', tool_input: { command: 'echo hi' } }),
  antigravity: (t) => ({ hookEventName: 'PreToolUse', workspacePaths: [cwd(t)], toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } } }),
};
// What each agent reads as a block: exit code 2 with the reason on stderr, plus the deny answer where the agent has one.
// OpenCode's plugin turns an empty answer into a blocked call, never into an allow.
const STDOUT = {
  cursor: (o) => o.permission === 'deny',
  gemini: (o) => o.decision === 'deny',
  copilot: (o) => o.permissionDecision === 'deny',
  antigravity: (o) => o.decision === 'deny',
};

for (const agent of Object.keys(CASES)) {
  test(agent + ': a normalize failure is blocked', (t) => {
    const r = run(t, agent, CASES[agent](t), true);
    assert.equal(r.status, agent === 'antigravity' ? 0 : 2, r.stderr + r.stdout);
    if (agent !== 'antigravity') assert.match(r.stderr, /zn hook: /);
    if (STDOUT[agent]) assert.ok(STDOUT[agent](JSON.parse(r.stdout)), r.stdout);
    else if (agent === 'opencode') assert.equal(r.stdout, '');
  });
}

test('claude-code: a normalize failure on a Stop event stays an ask that does not block', (t) => {
  const r = run(t, 'claude-code', { hook_event_name: 'Stop', cwd: cwd(t) }, true);
  assert.equal(r.status, 0, r.stderr);
});

test('control: without the fault the same events are not refused', (t) => {
  for (const agent of ['claude-code', 'cursor', 'gemini', 'copilot', 'opencode']) {
    const r = run(t, agent, CASES[agent](t), false);
    assert.equal(r.status, 0, agent + ': ' + r.stderr);
  }
});
