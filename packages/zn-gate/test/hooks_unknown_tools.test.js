'use strict';

process.env.ZN_STATS = 'off';

// B-2404: Copilot (VS Code) sends its own tool names through the Claude Code hook. A name zn does not know must still
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
const PREFIX = 'ZN_AGENT=x "node" "run.js" --';

function pre(tool_name, tool_input, cwd) {
  return { session_id: 's1', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't1' };
}
const run = (raw) => runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: PREFIX });
const denied = (r) => r.output && r.output.hookSpecificOutput && r.output.hookSpecificOutput.permissionDecision === 'deny';

for (const name of ['view', 'read_file', 'readFile']) {
  test('Copilot tool ' + name + ' on a secret file is blocked in the Claude Code hook', async (t) => {
    const dir = tempDir(t, 'zn-b2404-');
    const r = await run(pre(name, { path: AWS }, dir));
    assert.ok(denied(r), JSON.stringify(r.output));
  });
}

test('an unknown tool with filePath or an array of paths is checked', async (t) => {
  const dir = tempDir(t, 'zn-b2404-');
  assert.ok(denied(await run(pre('open_document', { filePath: AWS }, dir))));
  assert.ok(denied(await run(pre('multi_open', { files: [path.join(dir, 'a.txt'), AWS] }, dir))));
});

for (const name of ['run_in_terminal', 'runInTerminal']) {
  test('Copilot tool ' + name + ' with a secret read is blocked', async (t) => {
    const dir = tempDir(t, 'zn-b2404-');
    const r = await run(pre(name, { command: 'cat ' + AWS }, dir));
    assert.ok(denied(r), JSON.stringify(r.output));
  });
}

test('run_in_terminal with a destructive command is blocked', async (t) => {
  const dir = tempDir(t, 'zn-b2404-');
  const r = await run(pre('run_in_terminal', { command: 'rm -rf ~' }, dir));
  assert.ok(denied(r), JSON.stringify(r.output));
});

test('benign calls of unknown tools pass with no opinion', async (t) => {
  const dir = tempDir(t, 'zn-b2404-');
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
