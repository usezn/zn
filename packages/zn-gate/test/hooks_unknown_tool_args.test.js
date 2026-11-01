'use strict';

process.env.ZN_STATS = 'off';

// Copilot and ZCode: a tool zn does not know, or a call whose arguments cannot be read, must not pass with no opinion.
// Malformed arguments are refused on every tool; bounded nested arguments of an unknown tool get the same shell, read and
// write checks as the top level. Values are fictitious.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const copilot = require('../lib/agents/copilot');
const zcode = require('../lib/agents/zcode');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const HOME = process.env.HOME || '/home/u';
const AWS = path.join(HOME, '.aws', 'credentials');
const PREFIX = 'ZN_AGENT=x "node" "run.js" --';
const opts = () => ({ engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: PREFIX });

const runCopilot = (cwd, toolName, toolArgs) => runner.handle(copilot, { cwd, toolName, toolArgs }, opts());
const runCopilotVsCode = (cwd, toolName, input) => runner.handle(copilot, { hook_event_name: 'PreToolUse', cwd, tool_name: toolName, tool_input: input }, opts());
const runZcode = (cwd, toolName, input) => runner.handle(zcode, { hook_event_name: 'PreToolUse', cwd, tool_name: toolName, tool_input: input }, opts());

const copilotDeny = (r) => r.output && r.output.permissionDecision === 'deny' ? r.output.permissionDecisionReason : null;
const zcodeDeny = (r) => r.output && r.output.hookSpecificOutput && r.output.hookSpecificOutput.permissionDecision === 'deny'
  ? r.output.hookSpecificOutput.permissionDecisionReason : null;

const AGENTS = [
  { name: 'Copilot', run: runCopilot, deny: copilotDeny },
  { name: 'ZCode', run: runZcode, deny: zcodeDeny },
];

for (const a of AGENTS) {
  test(a.name + ': an unknown tool with arguments that are not an object is denied with a reason', async (t) => {
    const dir = tempDir(t, 'zn-b2589-');
    for (const bad of ['{"command":', '[1,2]', '42', 'true', 'null-ish', ['cat', 'x'], 7, true]) {
      const reason = a.deny(await a.run(dir, 'custom_shell', bad));
      assert.ok(reason && /could not read/.test(reason), a.name + ' ' + JSON.stringify(bad) + ': ' + reason);
    }
  });

  test(a.name + ': known tools with arguments that are not an object are denied too', async (t) => {
    const dir = tempDir(t, 'zn-b2589-');
    const names = a.name === 'Copilot' ? ['bash', 'view', 'web_fetch', 'glob'] : ['Bash', 'Read', 'WebFetch', 'Glob', 'mcp__srv__tool'];
    for (const n of names) {
      const reason = a.deny(await a.run(dir, n, '{"command":'));
      assert.ok(reason, a.name + ' ' + n);
    }
  });

  test(a.name + ': a nested command in an unknown tool is judged like a shell command', async (t) => {
    const dir = tempDir(t, 'zn-b2589-');
    assert.ok(a.deny(await a.run(dir, 'custom_shell', { payload: { command: 'cat ' + AWS } })));
    assert.ok(a.deny(await a.run(dir, 'custom_shell', { payload: { command: 'rm -rf ~' } })));
    assert.ok(a.deny(await a.run(dir, 'custom_shell', { steps: [{ label: 'x' }, { run: { cmd: 'rm -rf ~' } }] })));
    assert.ok(a.deny(await a.run(dir, 'custom_shell', { command: ['cat', AWS] })));
  });

  test(a.name + ': a secret file named under any key of an unknown tool is denied', async (t) => {
    const dir = tempDir(t, 'zn-b2589-');
    assert.ok(a.deny(await a.run(dir, 'custom_open', { payload: { value: AWS } })));
    assert.ok(a.deny(await a.run(dir, 'custom_open', { items: [{ inner: { thing: AWS } }] })));
  });

  test(a.name + ': an unknown tool with a command of the wrong type or nested too deeply is denied', async (t) => {
    const dir = tempDir(t, 'zn-b2589-');
    assert.ok(a.deny(await a.run(dir, 'custom_shell', { command: 7 })));
    assert.ok(a.deny(await a.run(dir, 'custom_shell', { command: { nested: 'x' } })));
    let deep = { command: 'cat ' + AWS };
    for (let i = 0; i < 12; i++) deep = { wrap: deep };
    assert.ok(a.deny(await a.run(dir, 'custom_shell', deep)));
  });

  test(a.name + ': benign unknown tools still pass with no opinion', async (t) => {
    const dir = tempDir(t, 'zn-b2589-');
    assert.equal((await a.run(dir, 'some_new_tool', { query: 'hello', options: { limit: 3, tags: ['a', 'b'] } })).output, null);
    assert.equal((await a.run(dir, 'some_new_tool', {})).output, null);
    assert.equal((await a.run(dir, 'some_new_tool', { payload: { command: 'npm test' } })).output, null);
    assert.equal((await a.run(dir, 'some_new_tool', { payload: { value: path.join(dir, 'src.js') } })).output, null);
  });
}

test('Copilot: the VS Code spelling (tool_input) is refused when malformed, and a missing input is still empty', async (t) => {
  const dir = tempDir(t, 'zn-b2589-');
  assert.ok(copilotDeny(await runCopilotVsCode(dir, 'custom_shell', '{"command":')));
  assert.ok(copilotDeny(await runCopilotVsCode(dir, 'custom_shell', 5)));
  assert.equal((await runCopilotVsCode(dir, 'some_new_tool', undefined)).output, null);
});

test('ZCode: a JSON string input is read, a missing input is empty', async (t) => {
  const dir = tempDir(t, 'zn-b2589-');
  assert.ok(zcodeDeny(await runZcode(dir, 'custom_shell', JSON.stringify({ payload: { command: 'cat ' + AWS } }))));
  assert.equal((await runZcode(dir, 'some_new_tool', JSON.stringify({ query: 'hello' }))).output, null);
  assert.equal((await runZcode(dir, 'some_new_tool', undefined)).output, null);
});

test('known tools keep their shape', () => {
  assert.equal(copilot.normalize({ toolName: 'bash', toolArgs: { command: 'ls' } }).tool, 'bash');
  assert.equal(copilot.normalize({ toolName: 'view', toolArgs: { path: '/tmp/example/a' } }).tool, 'read');
  assert.equal(zcode.normalize({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }).tool, 'bash');
  assert.equal(zcode.normalize({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/example/a' } }).tool, 'read');
});

// Review cases: a nested task line is built argument by argument the way VS Code builds it, and every reading is judged.
for (const a of AGENTS) {
  test(a.name + ': a nested task whose argument chains a second command is judged on the raw line too', async (t) => {
    const dir = tempDir(t, 'zn-b2589-');
    assert.ok(a.deny(await a.run(dir, 'create_and_run_task', { task: { type: 'shell', command: 'echo', args: ['x&&rm -rf ~'] } })));
  });
  test(a.name + ': a nested task argument given as {value} is read, not dropped', async (t) => {
    const dir = tempDir(t, 'zn-b2589-');
    assert.ok(a.deny(await a.run(dir, 'create_and_run_task', { task: { type: 'shell', command: 'rm', args: ['-rf', { value: '~' }] } })));
  });
  test(a.name + ': a nested task argument zn cannot read (a number) is denied with a reason', async (t) => {
    const dir = tempDir(t, 'zn-b2589-');
    const r = a.deny(await a.run(dir, 'create_and_run_task', { task: { type: 'shell', command: 'ls', args: [42] } }));
    assert.ok(r); assert.match(r, /could not read/i);
  });
}

test('commandScan builds the nested lines with the VS Code reading and keeps the rest', () => {
  const s = copilot.commandScan({ task: { command: 'echo', args: ['x&&rm -rf ~'] } });
  assert.equal(s.bad, false);
  assert.ok(s.command.split('\n').includes('echo x&&rm -rf ~'));
  assert.equal(copilot.commandScan({ task: { command: 'ls', args: [42] } }).bad, true);
  assert.ok(copilot.commandScan({ a: { b: { c: { command: 'npm test' } } } }).command.split('\n').includes('npm test'));
  assert.equal(copilot.commandScan({ q: 'hello' }).command, undefined);
});
