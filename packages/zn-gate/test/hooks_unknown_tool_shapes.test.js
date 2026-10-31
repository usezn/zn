'use strict';

process.env.ZN_STATS = 'off';

// B-2823: an unknown tool whose command is a list, a number or an object, or sits under input, commandLine, command_line
// or executable + args, is judged like any shell line; a command-like key zn cannot read is refused. Values are fictitious.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const copilot = require('../lib/agents/copilot');
const claude = require('../lib/agents/claude-code');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const HOME = process.env.HOME || '/home/u';
const AWS = path.join(HOME, '.aws', 'credentials');
const opts = () => ({ engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });

const AGENTS = [
  {
    name: 'Copilot',
    run: (cwd, tool, args) => runner.handle(copilot, { cwd, toolName: tool, toolArgs: args }, opts()),
    deny: (r) => (r.output && r.output.permissionDecision === 'deny' ? r.output.permissionDecisionReason : null),
  },
  {
    name: 'Claude-format',
    run: (cwd, tool, args) => runner.handle(claude, { hook_event_name: 'PreToolUse', cwd, tool_name: tool, tool_input: args }, opts()),
    deny: (r) => (r.output && r.output.hookSpecificOutput && r.output.hookSpecificOutput.permissionDecision === 'deny'
      ? r.output.hookSpecificOutput.permissionDecisionReason : null),
  },
];

for (const a of AGENTS) {
  test(a.name + ': a command given as a list, under another key or as executable + args is judged', async (t) => {
    const dir = tempDir(t, 'zn-b2823-');
    const bad = [
      { command: ['cat', AWS] },
      { cmd: ['rm', '-rf', '~'] },
      { input: 'cat ' + AWS },
      { commandLine: 'cat ' + AWS },
      { command_line: 'rm -rf ~' },
      { CommandLine: 'rm -rf ~' },
      { executable: 'cat', args: [AWS] },
      { executable: 'rm', argv: ['-rf', '~'] },
      { payload: { commandLine: 'cat ' + AWS } },
      { command: 'ls', cmd: 'rm -rf ~' },
    ];
    for (const args of bad) assert.ok(a.deny(await a.run(dir, 'run_in_terminal', args)), a.name + ' ' + JSON.stringify(args));
  });

  test(a.name + ': a command-like key zn cannot read is refused with a reason', async (t) => {
    const dir = tempDir(t, 'zn-b2823-');
    const bad = [
      { command: 42 },
      { command: { run: 'ls' } },
      { command: [] },
      { command: ['ls', 7] },
      { command: ['ls', ['-la']] },
      { commandLine: 5 },
      { command_line: { a: 1 } },
      { executable: 'ls', args: [1] },
      { executable: 'ls', args: 'x' },
    ];
    for (const args of bad) {
      const reason = a.deny(await a.run(dir, 'run_in_terminal', args));
      assert.match(reason || '', /could not read/, a.name + ' ' + JSON.stringify(args));
    }
  });

  test(a.name + ': benign twins of those shapes still pass', async (t) => {
    const dir = tempDir(t, 'zn-b2823-');
    const ok = [
      { command: ['npm', 'test'] },
      { input: 'hello world' },
      { input: { query: 'hello' } },
      { input: { nested: { list: [1, 2] } }, limit: 3 },
      { commandLine: 'npm test' },
      { command_line: 'ls -la' },
      { executable: 'node', args: ['--version'] },
      { executable: 'node', argv: ['--version'] },
      { payload: { command: ['git', 'status'] } },
    ];
    for (const args of ok) assert.equal((await a.run(dir, 'run_in_terminal', args)).output, null, a.name + ' ' + JSON.stringify(args));
  });
}
