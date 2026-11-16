'use strict';

// An agent that changes the format of the data it sends to its hook must not make zn fail in an obscure way:
// the message names the agent and the update command. The decision of each case stays what it was: a call whose
// tool or command cannot be read is blocked, and an event with a name zn does not know is not checked (the
// answer is the same as before), but now says so on stderr. The payloads are made up for each agent.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNNER = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');
const created = [];
after(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-formatchange-'));
created.push(home);

function run(agent, payload, hookEvent) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return spawnSync(process.execPath, [RUNNER, agent], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ZN_HOOK_FAIL_MODE: '', CLAUDE_PLUGIN_ROOT: '', ZN_HOOK_EVENT: hookEvent || '' },
  });
}

const sh = { command: 'echo hi' };
const std = (ev, extra) => ({ hook_event_name: ev, cwd: home, tool_name: 'Bash', tool_input: sh, ...extra });
const wrap = (inner) => ({ payload: inner });

const LABEL = { 'claude-code': 'Claude Code', codex: 'Codex CLI', cursor: 'Cursor', opencode: 'OpenCode', antigravity: 'Antigravity', zcode: 'ZCode', copilot: 'GitHub Copilot CLI', gemini: 'Gemini CLI' };
const AG = { name: 'run_command', args: { CommandLine: 'echo hi' } };
const COP = { cwd: home, toolName: 'bash', toolArgs: JSON.stringify(sh) };

// block: the call was refused (the answer says deny). pass: the answer is the one an unknown event always got.
const CASES = [
  ['claude-code', 'renamed tool field', { hook_event_name: 'PreToolUse', cwd: home, toolName: 'Bash', toolInput: sh }, 'block'],
  ['claude-code', 'unknown event', std('PreToolUseV2'), 'pass', ''],
  ['claude-code', 'extra wrapper', wrap(std('PreToolUse')), 'pass', ''],
  ['codex', 'renamed tool field', { hook_event_name: 'PreToolUse', cwd: home, toolName: 'Bash', toolInput: sh }, 'block'],
  ['codex', 'unknown event', std('PreToolUseV2'), 'pass', ''],
  ['codex', 'extra wrapper', wrap(std('PreToolUse')), 'pass', ''],
  ['zcode', 'renamed tool field', { hook_event_name: 'PreToolUse', cwd: home, tool: 'Bash', args: sh }, 'block'],
  ['zcode', 'unknown event', std('PreToolUseV2'), 'pass', ''],
  ['zcode', 'extra wrapper', wrap(std('PreToolUse')), 'pass', ''],
  ['cursor', 'renamed tool field', { hook_event_name: 'preToolUse', cwd: home, tool: 'Shell' }, 'block'],
  ['cursor', 'unknown event', { hook_event_name: 'beforeShellExecutionV2', cwd: home, command: 'echo hi' }, 'pass', ''],
  ['cursor', 'extra wrapper', wrap({ hook_event_name: 'beforeShellExecution', cwd: home, command: 'echo hi' }), 'pass', ''],
  ['opencode', 'renamed tool field', { hook: 'tool.execute.before', cwd: home, toolName: 'bash', arguments: sh }, 'block'],
  ['opencode', 'unknown event', { hook: 'tool.execute.before.v2', cwd: home, tool: 'bash', args: sh }, 'pass', '{"action":"none"}'],
  ['opencode', 'extra wrapper', wrap({ hook: 'tool.execute.before', cwd: home, tool: 'bash', args: sh }), 'pass', '{"action":"none"}'],
  ['antigravity', 'renamed tool field', { workspacePaths: [home], toolInvocation: AG }, 'block'],
  ['antigravity', 'unknown event', { hookEventName: 'PreToolUseV2', workspacePaths: [home], toolCall: AG }, 'pass', '{}'],
  ['antigravity', 'extra wrapper', wrap({ workspacePaths: [home], toolCall: AG }), 'block'],
  ['copilot', 'renamed tool field', { hookEventName: 'preToolUse', cwd: home, tool: 'bash', toolArgs: JSON.stringify(sh) }, 'block'],
  ['copilot', 'unknown event', { hookEventName: 'preToolUseV2', ...COP }, 'pass', ''],
  ['copilot', 'extra wrapper', wrap({ hookEventName: 'preToolUse', ...COP }), 'pass', ''],
  ['gemini', 'renamed tool field', { hook_event_name: 'BeforeTool', cwd: home, name: 'run_shell_command', input: sh }, 'block'],
  ['gemini', 'unknown event', { hook_event_name: 'BeforeToolV2', cwd: home, tool_name: 'run_shell_command', tool_input: sh }, 'pass', ''],
  ['gemini', 'extra wrapper', wrap({ hook_event_name: 'BeforeTool', cwd: home, tool_name: 'run_shell_command', tool_input: sh }), 'block'],
];

for (const [agent, what, payload, decision, passAnswer] of CASES) {
  test(agent + ': ' + what + ' keeps its decision and names the update', () => {
    const r = run(agent, payload);
    assert.equal(r.status, 0, r.stderr);
    const text = decision === 'block' ? r.stdout : r.stderr;
    assert.ok(text.includes(LABEL[agent]), 'names the agent: ' + text);
    assert.ok(text.includes('npm install -g zn-gate@latest'), 'names the update: ' + text);
    assert.ok(text.includes('hooks install ' + agent), 'names the install step: ' + text);
    if (decision === 'block') {
      assert.match(r.stdout, /deny/);
    } else {
      assert.equal(r.stdout, passAnswer, 'the answer is the same as before');
      assert.doesNotMatch(r.stdout, /deny|block/);
    }
  });
}

test('the Claude Code plugin is told to update the plugin', () => {
  const r = spawnSync(process.execPath, [RUNNER, 'claude-code'], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: home, toolName: 'Bash' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ZN_HOOK_FAIL_MODE: '', CLAUDE_PLUGIN_ROOT: home },
  });
  assert.match(r.stdout, /claude plugin update zn-gate@usezn/);
});

test('truncated or garbage input keeps its own message and does not claim a format change', () => {
  for (const agent of Object.keys(LABEL)) {
    for (const bad of ['{"hook_event_name": "PreTool', 'not json at all']) {
      const r = run(agent, bad);
      assert.equal(r.status === 2 || r.stdout.includes('deny'), true, agent + ' still blocks: ' + r.stdout + r.stderr);
      assert.match(r.stderr, /not valid JSON/);
      assert.doesNotMatch(r.stderr + r.stdout, /changed the format/);
    }
  }
});

// The launcher tells the runner which hook it serves (ZN_HOOK_EVENT). On a hook that can block (a tool call before it
// runs, a prompt) an event zn cannot read is refused; on any other hook it still passes with the note.
const BLOCKING = [
  ['claude-code', 'PreToolUse', 'PostToolUse', std],
  ['claude-code', 'UserPromptSubmit', 'PostToolUse', std],
  ['codex', 'PreToolUse', 'PostToolUse', std],
  ['codex', 'UserPromptSubmit', 'PostToolUse', std],
  ['zcode', 'PreToolUse', 'PostToolUse', std],
  ['zcode', 'UserPromptSubmit', 'PostToolUse', std],
  ['cursor', 'beforeShellExecution', 'postToolUse', (ev) => ({ hook_event_name: ev, cwd: home, command: 'echo hi' })],
  ['cursor', 'beforeSubmitPrompt', 'postToolUse', (ev) => ({ hook_event_name: ev, cwd: home, command: 'echo hi' })],
];
for (const [agent, hook, postHook, make] of BLOCKING) {
  for (const [what, payload] of [['unknown event', make(hook + 'V2')], ['extra wrapper', wrap(make(hook))]]) {
    test(agent + ': ' + what + ' on the ' + hook + ' hook is blocked and names the update', () => {
      const r = run(agent, payload, hook);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.ok(r.stderr.includes('sent an event zn does not know, so zn cannot check it and blocked it'), r.stderr);
      assert.ok(r.stderr.includes(LABEL[agent]), r.stderr);
      assert.ok(r.stderr.includes('npm install -g zn-gate@latest'), r.stderr);
      assert.ok(r.stderr.includes('hooks install ' + agent), r.stderr);
      if (agent === 'cursor') assert.match(r.stdout, /"permission":"deny"/);
    });
    test(agent + ': ' + what + ' on the ' + postHook + ' hook is not blocked', () => {
      const r = run(agent, payload, postHook);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stderr.includes('so it was not checked'), r.stderr);
      assert.doesNotMatch(r.stdout, /deny|block/);
    });
  }
}

test('an agent with no way to tell its hook keeps the pass with the note, even when the variable is set', () => {
  for (const [agent, payload] of [['copilot', { hookEventName: 'preToolUseV2', ...COP }], ['opencode', { hook: 'tool.execute.before.v2', cwd: home, tool: 'bash', args: sh }]]) {
    const r = run(agent, payload, 'PreToolUse');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('so it was not checked'), r.stderr);
    assert.doesNotMatch(r.stdout, /deny/);
  }
});

test('the launcher script names the hook it serves for the runner', () => {
  const launcher = require('../lib/agents/launcher');
  const text = launcher.unixScript('claude-code', process.execPath, RUNNER, { runnerDigest: '', manifest: '' });
  assert.match(text, /unset ZN_HOOK_EVENT; case "\$ZN_EVENT" in ""\|\*\[!A-Za-z\]\*\) ;; \*\) export ZN_HOOK_EVENT="\$ZN_EVENT" ;; esac/);
  const win = launcher.windowsScript('claude-code', 'PreToolUse', 'C:/node/node.exe', 'C:/zn/lib/hooks/runner.js');
  assert.ok(win.includes("$env:ZN_HOOK_EVENT = 'PreToolUse'; "), 'the Windows script sets the event');
});

test('a real launcher blocks an unknown event on its PreToolUse hook', { skip: process.platform === 'win32' }, () => {
  const launcher = require('../lib/agents/launcher');
  const file = launcher.writeLauncher('claude-code', process.execPath, RUNNER, { home });
  const go = (event) => spawnSync('/bin/sh', [file, event], {
    input: JSON.stringify(wrap(std('PreToolUse'))),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, ZN_HOME: path.join(home, '.zn') },
  });
  const pre = go('PreToolUse');
  assert.equal(pre.status, 2, pre.stdout + pre.stderr);
  assert.ok(pre.stderr.includes('blocked it'), pre.stderr);
  const post = go('PostToolUse');
  assert.equal(post.status, 0, post.stdout + post.stderr);
});
