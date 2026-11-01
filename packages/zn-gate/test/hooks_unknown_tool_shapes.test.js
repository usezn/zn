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

// Benign tools whose field names only look like a command: a boolean, an object or a plain flag is data, not a command.
for (const a of AGENTS) {
  test(a.name + ': a boolean executable, a script object or an input object is not a command', async (t) => {
    const dir = tempDir(t, 'zn-b2888-');
    const ok = [
      { path: 'a.txt', executable: true },
      { filePath: 'a.sh', content: 'x', executable: false },
      { script: { lang: 'js' } },
      { script: { lang: 'js', body: 'x' }, name: 'build' },
      { input: { text: 'hello' } },
    ];
    for (const args of ok) assert.equal((await a.run(dir, 'custom_tool', args)).output, null, a.name + ' ' + JSON.stringify(args));
  });

  test(a.name + ': a script or executable that is a string or a list is still judged', async (t) => {
    const dir = tempDir(t, 'zn-b2888-');
    for (const args of [{ script: 'cat ' + AWS }, { script: ['cat', AWS] }, { executable: 'rm', args: ['-rf', '~'] }]) {
      assert.ok(a.deny(await a.run(dir, 'custom_tool', args)), a.name + ' ' + JSON.stringify(args));
    }
  });

  test(a.name + ': a command key of the wrong shape is still refused', async (t) => {
    const dir = tempDir(t, 'zn-b2888-');
    for (const args of [{ command: true }, { cmd: { run: 'ls' } }, { commandLine: false }, { command_line: { a: 1 } }]) {
      assert.match(a.deny(await a.run(dir, 'custom_tool', args)) || '', /could not read/, a.name + ' ' + JSON.stringify(args));
    }
  });

  test(a.name + ': a large or deep call to an unknown tool is asked about, and a command found in it is still denied', async (t) => {
    const dir = tempDir(t, 'zn-b2888-');
    const ask = (r) => {
      const o = r.output && (r.output.hookSpecificOutput || r.output);
      return o && o.permissionDecision === 'ask' ? o.permissionDecisionReason : null;
    };
    const blocks = Array.from({ length: 600 }, (_, i) => ({ type: 'paragraph', text: 'line ' + i }));
    let deep = { title: 'page' };
    for (let i = 0; i < 8; i++) deep = { wrap: deep };
    for (const args of [{ parent: 'example', children: blocks }, deep]) {
      const r = await a.run(dir, 'mcp_notion_create_page', args);
      assert.equal(a.deny(r), null);
      assert.match(ask(r) || '', /larger or deeper/);
    }
    const r = await a.run(dir, 'mcp_notion_create_page', { children: blocks, command: 'cat ' + AWS });
    assert.ok(a.deny(r));
  });
}
