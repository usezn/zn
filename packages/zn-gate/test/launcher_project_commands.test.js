'use strict';

// lib/agents/launcher.js: the project hook command for every agent and event it
// knows, and the exact Windows script check against a one-character change.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

const launcher = require('../lib/agents/launcher');

const AGENTS = ['claude-code', 'codex', 'cursor', 'opencode', 'antigravity', 'copilot', 'gemini', 'zcode'];
const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'UserPromptExpansion', 'PermissionRequest', 'BeforeTool',
  'beforeMCPExecution', 'beforeReadFile', 'beforeShellExecution', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse'];

const posix = process.platform !== 'win32';

test('projectShCommand is a sh -c command naming the agent for every agent and event', () => {
  for (const agent of AGENTS) {
    for (const event of [undefined, ...EVENTS]) {
      const cmd = launcher.projectShCommand(agent, event);
      const label = agent + '/' + event;
      assert.ok(cmd.startsWith('sh -c '), label);
      assert.ok(cmd.includes('hook' + (agent === 'antigravity' ? '${IFS}' : ' ') + agent), label);
      assert.equal(cmd, launcher.projectShCommand(agent, event), label);
      assert.ok(launcher.isProjectGuard(cmd, agent), label);
      assert.ok(launcher.isProjectGuardExact(cmd, agent), label);
    }
  }
});

test('projectShCommand is not accepted for another agent', () => {
  assert.equal(launcher.isProjectGuardExact(launcher.projectShCommand('codex', 'PreToolUse'), 'cursor'), false);
});

test('projectShCommand differs between a blocking and a non-blocking event', () => {
  assert.notEqual(launcher.projectShCommand('codex', 'PreToolUse'), launcher.projectShCommand('codex', 'PostToolUse'));
  assert.notEqual(launcher.projectShCommand('cursor', 'beforeShellExecution'), launcher.projectShCommand('cursor', 'postToolUse'));
  assert.notEqual(launcher.projectShCommand('copilot', 'preToolUse'), launcher.projectShCommand('copilot', 'postToolUse'));
});

test('projectShCommand blocks with exit 2 on a blocking event and exits 0 on one that only warns', () => {
  assert.match(launcher.projectShCommand('claude-code', 'PreToolUse'), /exit 2/);
  assert.doesNotMatch(launcher.projectShCommand('claude-code', 'PostToolUse'), /' >&2; exit 2/);
  assert.match(launcher.projectShCommand('claude-code', 'PostToolUse'), /systemMessage/);
});

test('projectShCommand with no spaces for Antigravity and a quoted script for the others', () => {
  const anti = launcher.projectShCommand('antigravity');
  assert.equal(anti.slice('sh -c '.length).includes(' '), false);
  assert.ok(launcher.projectShCommand('codex', 'PreToolUse').startsWith("sh -c '"));
});

test('projectShCommand rejects a bad agent id or event name', () => {
  assert.throws(() => launcher.projectShCommand('Bad Agent', 'PreToolUse'), /bad agent id/);
  assert.throws(() => launcher.projectShCommand('codex', 'Pre Tool; x'), /bad event name/);
  assert.throws(() => launcher.projectShCommand('codex', 'Pre-Tool'), /bad event name/);
});

test('projectShCommand parses as shell script for every agent and event', { skip: !posix }, () => {
  for (const agent of AGENTS) {
    for (const event of [undefined, ...EVENTS]) {
      const cmd = launcher.projectShCommand(agent, event);
      const r = spawnSync('sh', ['-n', '-c', cmd], { encoding: 'utf8' });
      assert.equal(r.status, 0, agent + '/' + event + ': ' + r.stderr);
    }
  }
});

test('isProjectWindowsScriptExact accepts the script of every agent and event', () => {
  for (const agent of AGENTS) {
    for (const event of [undefined, ...EVENTS]) {
      assert.ok(launcher.isProjectWindowsScriptExact(launcher.projectWindowsScript(agent, event), agent), agent + '/' + event);
    }
  }
});

test('isProjectWindowsScriptExact rejects a script that differs by one character', () => {
  for (const agent of ['codex', 'cursor', 'gemini']) {
    const script = launcher.projectWindowsScript(agent, 'PreToolUse');
    const variants = {
      'changed first': 'X' + script.slice(1),
      'changed middle': script.slice(0, 200) + (script[200] === 'a' ? 'b' : 'a') + script.slice(201),
      'changed last': script.slice(0, -1) + (script.endsWith('x') ? 'y' : 'x'),
      removed: script.slice(0, 300) + script.slice(301),
      added: script.slice(0, 300) + ' ' + script.slice(300),
      'trailing newline': script + '\n',
      'leading space': ' ' + script,
      truncated: script.slice(0, -1),
    };
    for (const [name, v] of Object.entries(variants)) {
      assert.notEqual(v, script, name);
      assert.equal(launcher.isProjectWindowsScriptExact(v, agent), false, agent + ': ' + name);
    }
  }
});

test('isProjectWindowsScriptExact rejects another agent, non-strings and the empty string', () => {
  const script = launcher.projectWindowsScript('codex', 'PreToolUse');
  assert.equal(launcher.isProjectWindowsScriptExact(script, 'cursor'), false);
  assert.equal(launcher.isProjectWindowsScriptExact('', 'codex'), false);
  assert.equal(launcher.isProjectWindowsScriptExact(undefined, 'codex'), false);
  assert.equal(launcher.isProjectWindowsScriptExact(null, 'codex'), false);
  assert.equal(launcher.isProjectWindowsScriptExact(42, 'codex'), false);
  assert.equal(launcher.isProjectWindowsScriptExact(script, 'Bad Agent'), false);
});
