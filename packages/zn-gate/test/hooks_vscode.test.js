'use strict';

process.env.ZN_STATS = 'off';

// VS Code agent hooks (Local harness, Preview): fixtures follow the documented
// contract (https://code.visualstudio.com/docs/agents/reference/hooks-reference).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { getAdapter, listAdapters } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const vscode = getAdapter('vscode');

function pre(tool_name, tool_input, extra = {}) {
  return { timestamp: '2026-10-18T10:00:00.000Z', cwd: '/work/proj', session_id: 's1', hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'tool-123', ...extra };
}

function run(raw) {
  return runner.handle(vscode, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
}

test('registry lists vscode', () => {
  assert.ok(listAdapters().includes('vscode'));
});

test('normalize: shell by name and by input shape', () => {
  assert.equal(vscode.normalize(pre('runTerminalCommand', { command: 'ls' })).tool, 'bash');
  assert.equal(vscode.normalize(pre('SomeNewTool', { command: 'ls' })).tool, 'bash');
  assert.equal(vscode.normalize(pre('powershell', { command: 'dir' })).tool, 'powershell');
});

test('normalize: file tools collect every path', () => {
  const r = vscode.normalize(pre('readFile', { filePath: '/home/u/.ssh/id_rsa' }));
  assert.equal(r.tool, 'read');
  assert.equal(r.input.path, '/home/u/.ssh/id_rsa');
  const w = vscode.normalize(pre('editFiles', { files: ['a.txt', { path: '.env' }] }));
  assert.equal(w.tool, 'write');
  assert.deepEqual(w.input.paths, ['a.txt', '.env']);
});

test('normalize: unknown tool gets no opinion; other events are ignored', () => {
  assert.equal(vscode.normalize(pre('mystery', { q: 1 })).tool, 'mystery');
  assert.equal(vscode.normalize({ hook_event_name: 'SessionStart' }).event, null);
  assert.equal(vscode.normalize(null), null);
});

test('deny: reading a credential file returns the documented deny JSON', async () => {
  const r = await run(pre('readFile', { filePath: path.join(process.env.HOME || '/home/u', '.aws', 'credentials') }));
  assert.equal(r.output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(r.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(r.output.hookSpecificOutput.permissionDecisionReason);
});

test('deny: a write that includes a credential file among several', async () => {
  const r = await run(pre('editFiles', { files: ['src/a.js', path.join(process.env.HOME || '/home/u', '.zn', 'vault.json')] }));
  assert.equal(r.output.hookSpecificOutput.permissionDecision, 'deny');
});

test('no opinion (never a bare allow) for a harmless command and for unknown tools', async () => {
  assert.equal((await run(pre('runTerminalCommand', { command: 'echo hello' }))).output, null);
  assert.equal((await run(pre('mystery', { q: 1 }))).output, null);
});

test('PostToolUse and other events produce no output', async () => {
  const r = await run({ hook_event_name: 'PostToolUse', tool_name: 'runTerminalCommand', tool_input: { command: 'ls' }, tool_response: 'x' });
  assert.equal(r.output, null);
});

test('install (project): flat entries in .github/hooks/zn-gate.json, uninstall removes the file', (t) => {
  const dir = tempDir(t, 'zn-vscode-');
  const rep = vscode.install({ scope: 'project', projectDir: dir });
  const file = path.join(dir, '.github', 'hooks', 'zn-gate.json');
  assert.equal(rep.settings, file);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(data.hooks), ['PreToolUse']);
  const [h] = data.hooks.PreToolUse;
  assert.equal(h.type, 'command');
  assert.equal(h.command, 'zn hook vscode');
  assert.equal(h.matcher, undefined);
  assert.equal(h.hooks, undefined);
  assert.equal(typeof h.timeout, 'number');
  // idempotent
  vscode.install({ scope: 'project', projectDir: dir });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse.length, 1);
  const un = vscode.uninstall({ scope: 'project', projectDir: dir });
  assert.equal(un.removed, 1);
  assert.equal(fs.existsSync(file), false);
});

test('install (user) keeps a foreign hook in the same file and uninstall leaves it', (t) => {
  const home = tempDir(t, 'zn-vscode-home-');
  const file = path.join(home, '.copilot', 'hooks', 'zn-gate.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ type: 'command', command: './mine.sh' }] } }));
  vscode.install({ scope: 'user', home, nodePath: '/usr/bin/node' });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.hooks.PreToolUse.length, 2);
  vscode.uninstall({ scope: 'user', home });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse, [{ type: 'command', command: './mine.sh' }]);
});

test('deny: an agent cannot edit the hook file that checks it', async () => {
  for (const f of ['.github/hooks/zn-gate.json', path.join(process.env.HOME || '/home/u', '.copilot', 'hooks', 'zn-gate.json')]) {
    const r = await run(pre('editFiles', { files: [f] }));
    assert.equal(r.output.hookSpecificOutput.permissionDecision, 'deny', f);
  }
});
