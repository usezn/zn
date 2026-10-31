'use strict';

process.env.ZN_STATS = 'off';

// Copilot (VS Code) sends its own tool names through the Claude Code hook. A name zn does not know must still
// get the read, write and shell checks when its input names a file or carries a command.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const adapter = require('../lib/agents/claude-code');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const HOME = process.env.HOME || '/home/u';
const AWS = path.join(HOME, '.aws', 'credentials');
const SSHKEY = path.join(HOME, '.ssh', 'id_rsa');
const PREFIX = 'ZN_AGENT=x "node" "run.js" --';

function pre(tool_name, tool_input, cwd) {
  return { session_id: 's1', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't1' };
}
const run = (raw) => runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: PREFIX });
const denied = (r) => r.output && r.output.hookSpecificOutput && r.output.hookSpecificOutput.permissionDecision === 'deny';

for (const name of ['view', 'read_file', 'readFile']) {
  test('Copilot tool ' + name + ' on a secret file is blocked in the Claude Code hook', async (t) => {
    const dir = tempDir(t, 'zn-unknown-tools-');
    const r = await run(pre(name, { path: AWS }, dir));
    assert.ok(denied(r), JSON.stringify(r.output));
  });
}

test('an unknown tool with filePath or an array of paths is checked', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  assert.ok(denied(await run(pre('open_document', { filePath: AWS }, dir))));
  assert.ok(denied(await run(pre('multi_open', { files: [path.join(dir, 'a.txt'), AWS] }, dir))));
});

for (const name of ['run_in_terminal', 'runInTerminal']) {
  test('Copilot tool ' + name + ' with a secret read is blocked', async (t) => {
    const dir = tempDir(t, 'zn-unknown-tools-');
    const r = await run(pre(name, { command: 'cat ' + AWS }, dir));
    assert.ok(denied(r), JSON.stringify(r.output));
  });
}

test('run_in_terminal with a destructive command is blocked', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  const r = await run(pre('run_in_terminal', { command: 'rm -rf ~' }, dir));
  assert.ok(denied(r), JSON.stringify(r.output));
});

test('benign calls of unknown tools pass with no opinion', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  assert.equal((await run(pre('read_file', { path: path.join(dir, 'src.js') }, dir))).output, null);
  assert.equal((await run(pre('run_in_terminal', { command: 'npm test' }, dir))).output, null);
  assert.equal((await run(pre('some_new_tool', { query: 'hello', limit: 3 }, dir))).output, null);
  assert.equal((await run(pre('some_new_tool', {}, dir))).output, null);
});

test('known tools are unchanged by the fallback', () => {
  assert.equal(adapter.normalize(pre('Read', { file_path: '/p/a' }, '/p')).tool, 'read');
  assert.equal(adapter.normalize(pre('Bash', { command: 'ls' }, '/p')).tool, 'bash');
  assert.equal(adapter.normalize(pre('mcp__s__t', { path: '/p/a' }, '/p')).tool, 'mcp');
});

// Patch and task tools: the paths of a patch and a command one level down are checked.
const patchOf = (...files) => '*** Begin Patch\n' + files.map((f) => '*** Update File: ' + f + '\n@@\n-a\n+b').join('\n') + '\n*** End Patch';
const copilot = require('../lib/agents/copilot');
const runCopilot = (raw) => runner.handle(copilot, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: PREFIX });
const copilotDenied = (r) => Boolean(r.output && r.output.permissionDecision && r.output.permissionDecision !== 'allow');

for (const file of ['.github/hooks/zn-gate.json', '.claude/settings.json', AWS]) {
  test('apply_patch on ' + path.basename(file) + ' is blocked in the Claude Code hook', async (t) => {
    const dir = tempDir(t, 'zn-unknown-tools-');
    const r = await run(pre('apply_patch', { input: patchOf(file), explanation: 'x' }, dir));
    assert.ok(denied(r) || (r.output && r.output.hookSpecificOutput.permissionDecision === 'ask'), JSON.stringify(r.output));
  });
  test('apply_patch on ' + path.basename(file) + ' is blocked in the Copilot hook', async (t) => {
    const dir = tempDir(t, 'zn-unknown-tools-');
    const r = await runCopilot({ cwd: dir, toolName: 'apply_patch', toolArgs: { input: patchOf(file) } });
    assert.ok(copilotDenied(r), JSON.stringify(r.output));
  });
}

test('a patch with Delete File and Move to headers names those files too', () => {
  const ev = adapter.normalize(pre('apply_patch', { input: '*** Begin Patch\n*** Delete File: a.txt\n*** Update File: b.txt\n*** Move to: c.txt\n@@\n-a\n+b\n*** End Patch' }, '/p'));
  assert.equal(ev.tool, 'write');
  assert.deepEqual([...ev.input.paths].sort(), ['a.txt', 'b.txt', 'c.txt']);
});

test('a benign patch on src/x.js passes with no opinion in both adapters', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  assert.equal((await run(pre('apply_patch', { input: patchOf('src/x.js') }, dir))).output, null);
  assert.equal((await runCopilot({ cwd: dir, toolName: 'apply_patch', toolArgs: { input: patchOf('src/x.js') } })).output, null);
});

test('create_and_run_task is judged like a shell command in both adapters', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  const bad = { workspaceFolder: dir, task: { label: 'x', type: 'shell', command: 'cat', args: [AWS] } };
  assert.ok(denied(await run(pre('create_and_run_task', bad, dir))));
  assert.ok(copilotDenied(await runCopilot({ cwd: dir, toolName: 'create_and_run_task', toolArgs: bad })));
  const rm = { workspaceFolder: dir, task: { label: 'x', type: 'shell', command: 'rm -rf ~' } };
  assert.ok(denied(await run(pre('create_and_run_task', rm, dir))));
  assert.ok(copilotDenied(await runCopilot({ cwd: dir, toolName: 'create_and_run_task', toolArgs: rm })));
  const ok = { workspaceFolder: dir, task: { label: 'test', type: 'shell', command: 'npm', args: ['test'] } };
  assert.equal((await run(pre('create_and_run_task', ok, dir))).output, null);
  assert.equal((await runCopilot({ cwd: dir, toolName: 'create_and_run_task', toolArgs: ok })).output, null);
});

test('task.args are quoted like VS Code runs them: bash -c with a destructive or protected command is judged', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  const cases = [
    { command: 'bash', args: ['-c', 'rm -rf ~'] },
    { command: 'sh', args: ['-c', 'cat ' + AWS] },
  ];
  for (const task of cases) {
    const input = { workspaceFolder: dir, task: Object.assign({ label: 'x', type: 'shell' }, task) };
    assert.ok(denied(await run(pre('create_and_run_task', input, dir))), JSON.stringify(task));
    assert.ok(copilotDenied(await runCopilot({ cwd: dir, toolName: 'create_and_run_task', toolArgs: input })), JSON.stringify(task));
  }
  const ok = { workspaceFolder: dir, task: { label: 'x', type: 'shell', command: 'bash', args: ['-c', 'echo hello'] } };
  assert.equal((await run(pre('create_and_run_task', ok, dir))).output, null);
  assert.equal((await runCopilot({ cwd: dir, toolName: 'create_and_run_task', toolArgs: ok })).output, null);
});

test('VS Code shell task lines are judged as VS Code builds them, not as zn would quote them', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  const cases = [
    { type: 'shell', command: 'echo', args: ['x&&rm', '-rf', '~'] },
    { type: 'shell', command: 'echo', args: ["a' ; rm -rf ~ ; 'b"] },
    { type: 'shell', command: 'rm', args: ['-rf', { value: '~', quoting: 'strong' }] },
    { type: 'shell', command: { value: 'rm -rf ~', quoting: 'weak' } },
  ];
  for (const task of cases) {
    const input = { workspaceFolder: dir, task: Object.assign({ label: 'x' }, task) };
    assert.ok(denied(await run(pre('create_and_run_task', input, dir))), JSON.stringify(task));
    assert.ok(copilotDenied(await runCopilot({ cwd: dir, toolName: 'create_and_run_task', toolArgs: input })), JSON.stringify(task));
  }
});

test('VS Code decides quoting per argument: a mix of quoted and unquoted arguments is judged as one line', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  const cases = [
    { command: 'echo', args: ['a "b', 'x\nrm\t-rf\t~', 'c d" e'] },
    { command: 'echo', args: ['a "b', 'x\ncat\t' + AWS, 'c d" e'] },
    { command: 'echo', args: ['a "b', 'x\ncat\t' + SSHKEY, 'c d" e'] },
    { command: 'echo', args: ['x\nrm\t-rf\t~'] },
    { command: 'echo', args: ["'a b'", 'x\nrm -rf ~'] },
    { command: 'echo', args: ['a\\ b', 'x\nrm -rf ~', "c d'"] },
    { command: 'echo', args: [{ value: 'a b', quoting: 'escape' }, 'x\nrm -rf ~'] },
  ];
  for (const task of cases) {
    const input = { workspaceFolder: dir, task: Object.assign({ label: 'x', type: 'shell' }, task) };
    assert.ok(denied(await run(pre('create_and_run_task', input, dir))), JSON.stringify(task));
    assert.ok(copilotDenied(await runCopilot({ cwd: dir, toolName: 'create_and_run_task', toolArgs: input })), JSON.stringify(task));
  }
});

test('benign twins of the per-argument quoting cases pass', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  const cases = [
    { command: 'echo', args: ['a "b', 'x\nls\t-la', 'c d" e'] },
    { command: 'echo', args: ['a "b', 'x\necho\thello', 'c d" e'] },
    { command: 'echo', args: ["'hello world'", 'done'] },
    { command: 'echo', args: ['hello\\ world', 'done'] },
    { command: 'echo', args: [{ value: 'hello world', quoting: 'escape' }] },
    { command: 'echo', args: ['x\ttab'] },
  ];
  for (const task of cases) {
    const input = { workspaceFolder: dir, task: Object.assign({ label: 'x', type: 'shell' }, task) };
    assert.equal((await run(pre('create_and_run_task', input, dir))).output, null, JSON.stringify(task));
    assert.equal((await runCopilot({ cwd: dir, toolName: 'create_and_run_task', toolArgs: input })).output, null, JSON.stringify(task));
  }
});

test('a task command or argument zn cannot read is blocked, never dropped', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  const cases = [
    { type: 'shell', command: 'echo', args: [{ foo: 'bar' }] },
    { type: 'shell', command: 'echo', args: [42] },
    { type: 'shell', command: 'echo', args: 'hello' },
    { type: 'shell', command: { foo: 'rm -rf ~' } },
    { type: 'shell', command: 'echo', args: [{ value: 'x', quoting: 'bogus' }] },
  ];
  for (const task of cases) {
    const input = { workspaceFolder: dir, task: Object.assign({ label: 'x' }, task) };
    assert.ok(denied(await run(pre('create_and_run_task', input, dir))), JSON.stringify(task));
    assert.ok(copilotDenied(await runCopilot({ cwd: dir, toolName: 'create_and_run_task', toolArgs: input })), JSON.stringify(task));
  }
});

test('a process task has no shell: its arguments stay data, and benign tasks pass', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  const ok = [
    { type: 'process', command: 'echo', args: ['x&&rm', '-rf', '~'] },
    { type: 'shell', command: 'npm', args: ['test'] },
    { type: 'shell', command: 'bash', args: ['-c', 'echo hello'] },
    { type: 'shell', command: 'echo', args: [{ value: 'hello world', quoting: 'strong' }] },
  ];
  for (const task of ok) {
    const input = { workspaceFolder: dir, task: Object.assign({ label: 'x' }, task) };
    assert.equal((await run(pre('create_and_run_task', input, dir))).output, null, JSON.stringify(task));
    assert.equal((await runCopilot({ cwd: dir, toolName: 'create_and_run_task', toolArgs: input })).output, null, JSON.stringify(task));
  }
});

test('real Claude Code tools with a command field (SlashCommand, Skill) keep benign forms passing', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  assert.equal((await run(pre('SlashCommand', { command: '/review' }, dir))).output, null);
  assert.equal((await run(pre('Skill', { command: 'pdf' }, dir))).output, null);
});

// Follow-ups: a patch one level down, run_task after a tasks.json write, write wording, SlashCommand and Skill.
const fs = require('fs');
const reasonOf = (r) => (r.output && r.output.hookSpecificOutput ? r.output.hookSpecificOutput.permissionDecisionReason : r.output && r.output.permissionDecisionReason) || '';
const askedOrDenied = (r) => denied(r) || Boolean(r.output && r.output.hookSpecificOutput && r.output.hookSpecificOutput.permissionDecision === 'ask');

for (const file of ['.github/hooks/zn-gate.json', AWS]) {
  test('a patch nested one level down on ' + path.basename(file) + ' is blocked in both adapters', async (t) => {
    const dir = tempDir(t, 'zn-unknown-tools-');
    const shapes = [{ patch: { text: patchOf(file) } }, { change: { input: patchOf(file) } }, { edits: [{ diff: patchOf(file) }] }];
    for (const input of shapes) {
      assert.ok(askedOrDenied(await run(pre('some_patch_tool', input, dir))), JSON.stringify(input));
      assert.ok(copilotDenied(await runCopilot({ cwd: dir, toolName: 'some_patch_tool', toolArgs: input })), JSON.stringify(input));
    }
    const wrapped = { wrapper: { input: patchOf(file) } };
    assert.ok(askedOrDenied(await run(pre('apply_patch', wrapped, dir))));
    assert.ok(copilotDenied(await runCopilot({ cwd: dir, toolName: 'apply_patch', toolArgs: wrapped })));
  });
}

test('a benign patch nested one level down passes in both adapters', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  const input = { patch: { text: patchOf('src/x.js') } };
  assert.equal((await run(pre('some_patch_tool', input, dir))).output, null);
  assert.equal((await runCopilot({ cwd: dir, toolName: 'some_patch_tool', toolArgs: input })).output, null);
});

function writeTasks(dir, text) {
  fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.vscode', 'tasks.json'), text);
}
const runTask = (dir, id) => ({ workspaceFolder: dir, id });

test('run_task is judged against the task in tasks.json as it was just written', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  writeTasks(dir, '// tasks\n{\n  "version": "2.0.0",\n  /* comment */\n  "tasks": [\n' +
    '    { "label": "steal", "type": "shell", "command": "cat", "args": ["' + AWS + '"], },\n' +
    '    { "label": "build", "type": "shell", "command": "npm", "args": ["test"] },\n' +
    '    { "label": "wipe", "type": "shell", "command": "echo hi", "linux": { "command": "rm -rf ~" } },\n' +
    '    { "label": "chain", "type": "shell", "command": "echo hi", "dependsOn": ["steal"] },\n' +
    '  ]\n}\n');
  for (const id of ['steal', 'shell: steal', 'wipe', 'chain']) {
    assert.ok(denied(await run(pre('run_task', runTask(dir, id), dir))), id);
    assert.ok(copilotDenied(await runCopilot({ cwd: dir, toolName: 'run_task', toolArgs: runTask(dir, id) })), id);
  }
  assert.equal((await run(pre('run_task', runTask(dir, 'build'), dir))).output, null);
  assert.equal((await runCopilot({ cwd: dir, toolName: 'run_task', toolArgs: runTask(dir, 'build') })).output, null);
  // A task that is not in the file (built-in or from an extension) cannot be read here and is left to Copilot.
  assert.equal((await run(pre('run_task', runTask(dir, 'npm: test'), dir))).output, null);
});

test('run_task is refused when the task file or the task name cannot be read', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  writeTasks(dir, '{ "tasks": [ { "label": "x", ');
  assert.ok(denied(await run(pre('run_task', runTask(dir, 'x'), dir))));
  assert.ok(copilotDenied(await runCopilot({ cwd: dir, toolName: 'run_task', toolArgs: runTask(dir, 'x') })));
  assert.ok(denied(await run(pre('run_task', { workspaceFolder: dir }, dir))));
  assert.ok(copilotDenied(await runCopilot({ cwd: dir, toolName: 'run_task', toolArgs: { workspaceFolder: dir } })));
});

test('a refused write through an unknown write tool says the file was not changed', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  for (const name of ['replace_string_in_file', 'insert_edit_into_file', 'some_patch_tool']) {
    const input = name === 'some_patch_tool' ? { input: patchOf(AWS) } : { filePath: AWS, newString: 'x' };
    const reason = reasonOf(await run(pre(name, input, dir)));
    assert.ok(/was not changed/.test(reason) && !/was not read/.test(reason), name + ': ' + reason);
    const c = reasonOf(await runCopilot({ cwd: dir, toolName: name, toolArgs: input }));
    assert.ok(/was not changed/.test(c) && !/was not read/.test(c), name + ': ' + c);
  }
  // A read tool keeps the read wording.
  assert.ok(/was not read/.test(reasonOf(await run(pre('read_file', { filePath: AWS }, dir)))));
});

test('SlashCommand and Skill: a command field gets the shell checks, a benign one passes', async (t) => {
  const dir = tempDir(t, 'zn-unknown-tools-');
  assert.ok(denied(await run(pre('SlashCommand', { command: 'cat ' + AWS }, dir))));
  assert.ok(denied(await run(pre('Skill', { command: 'rm -rf ~' }, dir))));
  assert.equal((await run(pre('SlashCommand', { command: '/review src/a.js' }, dir))).output, null);
  assert.equal((await run(pre('Skill', { command: 'pdf' }, dir))).output, null);
  // The shapes with no command field and no path stay with no opinion.
  assert.equal((await run(pre('Skill', { skill: 'pdf', args: 'report.pdf' }, dir))).output, null);
  assert.equal((await run(pre('SlashCommand', { name: 'review' }, dir))).output, null);
});
