'use strict';

process.env.ZN_STATS = 'off';

// A question zn wants to ask must never turn into a silent pass in an agent that cannot show it: Codex CLI, Cursor
// (preToolUse, MCP and read hooks), OpenCode and Gemini CLI block the call instead, with the reason and the way to
// approve it. A payload that cannot be read (no tool name, no command, no event) is blocked in every adapter.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const HINT = /cannot show that question, so zn blocked the action instead/;
const NEXT = /tell the user exactly what was blocked/;

function run(id, raw, home) {
  return runner.handle(getAdapter(id), raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home, znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
}

/* The deny of each adapter, as a string for the reason (null when the answer is not a deny). */
function denyReason(id, out) {
  if (!out) return null;
  if (id === 'codex' || id === 'claude-code') {
    const h = out.hookSpecificOutput || {};
    if (h.permissionDecision === 'deny') return h.permissionDecisionReason;
    if (h.decision && h.decision.behavior === 'deny') return h.decision.message;
    return null;
  }
  if (id === 'zcode') {
    const h = out.hookSpecificOutput || {};
    return h.permissionDecision === 'deny' ? h.permissionDecisionReason : null;
  }
  if (id === 'cursor') return out.permission === 'deny' ? out.user_message : null;
  if (id === 'opencode') return out.action === 'deny' ? out.message : null;
  if (id === 'gemini' || id === 'antigravity') return out.decision === 'deny' ? out.reason : null;
  if (id === 'copilot') return out.permissionDecision === 'deny' ? out.permissionDecisionReason : null;
  return null;
}

const CWD = path.join(path.sep, 'work', 'proj');

/* An action that makes zn ask: a write to a file the agent reads as standing instructions. */
const ASKING = {
  codex: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi >> AGENTS.md' }, cwd: CWD },
  'cursor preToolUse': { hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: path.join(CWD, 'AGENTS.md') }, cwd: CWD },
  opencode: { hook: 'tool.execute.before', tool: 'bash', args: { command: 'echo hi >> AGENTS.md' }, cwd: CWD },
  gemini: { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'echo hi >> GEMINI.md' }, cwd: CWD },
  'gemini write_file': { hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: path.join(CWD, 'GEMINI.md'), content: 'x' }, cwd: CWD },
};

for (const [label, raw] of Object.entries(ASKING)) {
  const id = label.split(' ')[0];
  test(label + ': a question the agent cannot show is a deny with the reason and the way to approve it', async (t) => {
    const home = tempDir(t, 'zn-ask-deny-');
    const r = await run(id, raw, home);
    assert.equal(r.decision.decision, 'ask', 'zn decided to ask');
    const reason = denyReason(id, r.output);
    assert.ok(reason, 'the answer is a deny, not silence: ' + JSON.stringify(r.output));
    assert.match(reason, /AGENTS\.md|GEMINI\.md/, 'names what was blocked');
    assert.match(reason, HINT);
    assert.match(reason, NEXT);
    assert.match(reason, /run it themselves/);
  });
}

test('codex PermissionRequest gets the same deny for a question', async (t) => {
  const home = tempDir(t, 'zn-ask-deny-');
  const r = await run('codex', { ...ASKING.codex, hook_event_name: 'PermissionRequest' }, home);
  assert.equal(r.output.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(r.output.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(r.output.hookSpecificOutput.decision.message, HINT);
});

test('adapter level: Cursor MCP and read hooks turn a question into a deny; its shell hook keeps the ask', () => {
  const cursor = getAdapter('cursor');
  const ask = { decision: 'ask', message: 'zn: this call would send personal data (an email) to the MCP server m.' };
  const mcp = cursor.respond({ ...ask, event: { event: 'pre_tool', hookEvent: 'beforeMCPExecution', tool: 'mcp', input: {} } });
  assert.equal(mcp.permission, 'deny');
  assert.match(mcp.user_message, /personal data/);
  assert.match(mcp.agent_message, HINT);
  const read = cursor.respond({ ...ask, event: { event: 'pre_tool', hookEvent: 'beforeReadFile', tool: 'read', input: { path: '/x' } } });
  assert.equal(read.permission, 'deny');
  assert.match(read.user_message, HINT);
  const shell = cursor.respond({ ...ask, event: { event: 'pre_tool', hookEvent: 'beforeShellExecution', tool: 'bash', input: { command: 'x' } } });
  assert.equal(shell.permission, 'ask');
});

test('agents that can ask keep asking', () => {
  const ask = { decision: 'ask', message: 'q?' };
  const ev = { event: 'pre_tool', tool: 'bash', input: { command: 'x' } };
  assert.equal(getAdapter('claude-code').respond({ ...ask, event: ev }).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(getAdapter('zcode').respond({ ...ask, event: ev }).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(getAdapter('copilot').respond({ ...ask, event: ev }).permissionDecision, 'ask');
  assert.equal(getAdapter('antigravity').respond({ ...ask, event: ev }).decision, 'force_ask');
});

test('a soft question (a command already wrapped in zn run, whose approval the vault asks for) and a rewrite proposal stay silent', () => {
  const ev = { event: 'pre_tool', hookEvent: 'preToolUse', tool: 'bash', input: { command: 'x' } };
  const soft = { decision: 'ask', soft: true, message: 'zn: this command contains secret placeholders' };
  const rewrite = { decision: 'ask', updatedInput: { command: 'y' }, kind: 'restore', message: 'zn: puts back a value' };
  for (const d of [soft, rewrite]) {
    assert.equal(getAdapter('codex').respond({ ...d, event: ev }), null);
    assert.equal(getAdapter('cursor').respond({ ...d, event: ev }), null);
    assert.equal(getAdapter('gemini').respond({ ...d, event: ev }), null);
    assert.deepEqual(getAdapter('opencode').respond({ ...d, event: ev }), { action: 'none' });
  }
});

/* ------------------------- malformed pre-tool payloads ------------------------- */

const MALFORMED = [
  ['claude-code', 'no tool name', { hook_event_name: 'PreToolUse', cwd: CWD }],
  ['claude-code', 'Bash without a command', { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: CWD }],
  ['codex', 'no tool name', { hook_event_name: 'PreToolUse', cwd: CWD }],
  ['codex', 'PermissionRequest without a tool name', { hook_event_name: 'PermissionRequest', cwd: CWD }],
  ['codex', 'Bash without a command', { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: CWD }],
  ['cursor', 'preToolUse without a tool name', { hook_event_name: 'preToolUse', cwd: CWD }],
  ['cursor', 'beforeShellExecution without a command', { hook_event_name: 'beforeShellExecution', cwd: CWD }],
  ['cursor', 'beforeMCPExecution without a tool name', { hook_event_name: 'beforeMCPExecution', cwd: CWD }],
  ['cursor', 'beforeReadFile without a file', { hook_event_name: 'beforeReadFile', cwd: CWD }],
  ['opencode', 'no tool', { hook: 'tool.execute.before', cwd: CWD }],
  ['opencode', 'bash without arguments', { hook: 'tool.execute.before', tool: 'bash', cwd: CWD }],
  ['gemini', 'BeforeTool without a tool name', { hook_event_name: 'BeforeTool', cwd: CWD }],
  ['gemini', 'no event name and no tool', { cwd: CWD }],
  ['zcode', 'PreToolUse without a tool name', { hook_event_name: 'PreToolUse', cwd: CWD }],
  ['zcode', 'a tool call without an event name and without a tool name', { tool_input: {}, cwd: CWD }],
  ['copilot', 'preToolUse without a tool name', { hook_event_name: 'preToolUse', cwd: CWD }],
  ['copilot', 'arguments without a tool name or an event name', { toolArgs: {}, cwd: CWD }],
  ['antigravity', 'PreToolUse without a tool call', { hookEventName: 'PreToolUse', conversationId: 'c' }],
  ['antigravity', 'an empty object', {}],
  ['antigravity', 'a tool call without a name', { toolCall: { args: {} } }],
];

for (const [id, what, raw] of MALFORMED) {
  test(id + ': ' + what + ' is blocked, never allowed', async (t) => {
    const home = tempDir(t, 'zn-malformed-');
    const r = await run(id, raw, home);
    assert.ok(denyReason(id, r.output), 'a deny is printed: ' + JSON.stringify(r.output));
  });
}

test('Antigravity answers allow only for a real tool call that zn has no objection to', async (t) => {
  const home = tempDir(t, 'zn-malformed-');
  const ok = await run('antigravity', { toolCall: { name: 'run_command', args: { CommandLine: 'ls' } }, workspacePaths: [CWD] }, home);
  assert.equal(ok.output.decision, 'allow');
  const none = await run('antigravity', { hookEventName: 'PreToolUse' }, home);
  assert.equal(none.output.decision, 'deny');
});

test('Gemini: a payload that names another event is still ignored; one that names none is a BeforeTool', async (t) => {
  const home = tempDir(t, 'zn-malformed-');
  const other = await run('gemini', { hook_event_name: 'SessionStart', cwd: CWD }, home);
  assert.equal(other.output, null);
  const unnamed = await run('gemini', { tool_name: 'run_shell_command', tool_input: { command: 'ls' }, cwd: CWD }, home);
  assert.equal(unnamed.output, null, 'a readable call that zn has no objection to gets no opinion');
});

/* ---- a real question merged into a rewrite proposal must still be blocked (review blocker) ---- */

const { spawnSync } = require('child_process');
const fs = require('fs');

async function projectWithToken(t) {
  const dir = tempDir(t, 'zn-ask-restore-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'AGENTS.md\nGEMINI.md\n');
  const vault = createFakeVault();
  const token = await vault.mapToken(dir, 'AWS_KEY', 'AKIAIOSFODNN7EXAMPLE');
  return { dir, vault, token };
}

function runWith(id, raw, home, vault) {
  return runner.handle(getAdapter(id), raw, { engine: fakeEngine, vault, failMode: 'open', home, znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
}

const RESTORE_CASES = [
  ['codex Bash into AGENTS.md', 'codex', (dir, token) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo ' + token + ' >> AGENTS.md' }, cwd: dir })],
  ['gemini shell into GEMINI.md', 'gemini', (dir, token) => ({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'echo ' + token + ' >> GEMINI.md' }, cwd: dir })],
  ['opencode bash into AGENTS.md', 'opencode', (dir, token) => ({ hook: 'tool.execute.before', tool: 'bash', args: { command: 'echo ' + token + ' >> AGENTS.md' }, cwd: dir })],
  ['opencode write to AGENTS.md', 'opencode', (dir, token) => ({ hook: 'tool.execute.before', tool: 'write', args: { filePath: path.join(dir, 'AGENTS.md'), content: 'k=' + token }, cwd: dir })],
];

for (const [label, id, make] of RESTORE_CASES) {
  test('restorable token + instruction-file write (' + label + '): still a deny, not a pass', async (t) => {
    const { dir, vault, token } = await projectWithToken(t);
    const home = tempDir(t, 'zn-ask-restore-home-');
    const r = await runWith(id, make(dir, token), home, vault);
    assert.equal(r.decision.decision, 'ask');
    assert.ok(r.decision.updatedInput, 'the decision carries a rewrite (the case under test)');
    const reason = denyReason(id, r.output);
    assert.ok(reason, 'a deny, not silence: ' + JSON.stringify(r.output));
    assert.match(reason, HINT);
    assert.ok(!JSON.stringify(r.output).includes('AKIAIOSFODNN7EXAMPLE'));
  });
}

test('a rewrite proposal merged with an egress question (confirm) is a deny; a bare rewrite stays silent', () => {
  const ev = { event: 'pre_tool', hookEvent: 'preToolUse', tool: 'bash', input: { command: 'x' } };
  const merged = { decision: 'ask', updatedInput: { command: 'y' }, kind: 'restore', soft: false, confirm: true, message: 'zn: this command would send an email to a network host.' };
  for (const id of ['codex', 'cursor', 'gemini', 'opencode']) {
    const out = getAdapter(id).respond({ ...merged, event: id === 'cursor' ? { ...ev, hookEvent: 'beforeMCPExecution' } : ev });
    assert.ok(denyReason(id, out), id + ': ' + JSON.stringify(out));
  }
  const bare = { decision: 'ask', updatedInput: { command: 'y' }, kind: 'restore', message: 'zn: puts back a value' };
  assert.equal(getAdapter('codex').respond({ ...bare, event: ev }), null);
});

test('Cursor shell and ZCode Bash keep their native ask when a security question is merged with a rewrite', () => {
  const merged = { decision: 'ask', updatedInput: { command: 'y' }, kind: 'restore', soft: false, confirm: true, message: 'zn: this command would send an email to a network host.' };
  const cur = getAdapter('cursor').respond({ ...merged, event: { event: 'pre_tool', hookEvent: 'beforeShellExecution', tool: 'bash', input: { command: 'x' } } });
  assert.ok(cur && cur.permission === 'ask', 'cursor: ' + JSON.stringify(cur));
  const zc = getAdapter('zcode').respond({ ...merged, event: { event: 'pre_tool', hookEvent: 'PreToolUse', tool: 'Bash', input: { command: 'x' } } });
  assert.match(JSON.stringify(zc), /"ask"/, 'zcode: ' + JSON.stringify(zc));
});

test('Cursor shell and ZCode Bash stay silent on a bare rewrite proposal', () => {
  const bare = { decision: 'ask', updatedInput: { command: 'y' }, kind: 'restore', message: 'zn: puts back a value' };
  assert.equal(getAdapter('cursor').respond({ ...bare, event: { event: 'pre_tool', hookEvent: 'beforeShellExecution', tool: 'bash', input: { command: 'x' } } }), null);
  const zc = getAdapter('zcode').respond({ ...bare, event: { event: 'pre_tool', hookEvent: 'PreToolUse', tool: 'Bash', input: { command: 'x' } } });
  assert.doesNotMatch(JSON.stringify(zc) || '', /"ask"/);
});
