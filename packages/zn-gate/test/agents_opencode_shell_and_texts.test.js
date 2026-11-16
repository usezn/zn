'use strict';
process.env.ZN_STATS = 'off';

// shellBase and textsOf are internal to the OpenCode adapter, so they are checked through
// isPowerShellName, usesPowerShell and normalize.

const test = require('node:test');
const assert = require('node:assert/strict');
const oc = require('../lib/agents/opencode');

test('a POSIX path to bash is not PowerShell', () => {
  assert.equal(oc.isPowerShellName('/usr/bin/bash'), false);
  assert.equal(oc.usesPowerShell('/usr/bin/bash', 'linux'), false);
  assert.equal(oc.usesPowerShell('/usr/bin/bash', 'win32'), false);
});

test('a PowerShell name is recognised with any case, extension or path', () => {
  for (const n of ['pwsh', 'PWSH.EXE', 'pwsh-preview', 'powershell.exe', '/opt/example/pwsh', 'C:\\example\\PowerShell.exe']) {
    assert.equal(oc.isPowerShellName(n), true, n);
    assert.equal(oc.usesPowerShell(n, 'linux'), true, n);
  }
  assert.equal(oc.isPowerShellName('pwsh-lts'), false);
});

test('a Windows path with spaces is reduced to its last segment', () => {
  const p = 'C:\\Program Files\\Example Shell\\PowerShell.exe';
  assert.equal(oc.isPowerShellName(p), true);
  assert.equal(oc.isPowerShellName('C:\\Program Files\\PowerShell\\bash.exe'), false);
  assert.equal(oc.usesPowerShell('C:\\Program Files\\Example Git\\bin\\bash.exe', 'win32'), false);
  assert.equal(oc.usesPowerShell('C:\\Program Files\\Example Git\\bin\\cmd.exe', 'win32'), true);
});

test('an empty or non-string shell is PowerShell only on Windows', () => {
  for (const s of ['', undefined, null, 42, {}]) {
    assert.equal(oc.isPowerShellName(s), false);
    assert.equal(oc.usesPowerShell(s, 'linux'), false);
    assert.equal(oc.usesPowerShell(s, 'darwin'), false);
    assert.equal(oc.usesPowerShell(s, 'win32'), true);
  }
});

function pre(tool, args, extra) {
  return oc.normalize({ hook: 'tool.execute.before', tool, args, cwd: '/tmp/example', ...extra });
}

test('normalize maps a bash call to PowerShell from the shell path', () => {
  const a = pre('bash', { command: 'echo hi' }, { shell: 'pwsh.exe', platform: 'linux' });
  assert.equal(a.tool, 'powershell');
  const b = pre('bash', { command: 'echo hi' }, { shell: '/bin/bash', platform: 'linux' });
  assert.equal(b.tool, 'bash');
});

test('texts hold only top-level string values of the write, edit and patch tools', () => {
  assert.deepEqual(pre('write', { filePath: 'a.txt', content: 'one' }).input.texts, [{ key: ['content'], value: 'one' }]);
  assert.deepEqual(pre('edit', { filePath: 'a.txt', oldString: 'x', newString: 'y' }).input.texts, [
    { key: ['oldString'], value: 'x' },
    { key: ['newString'], value: 'y' },
  ]);
  assert.deepEqual(pre('bash', { command: 'ls', content: 'ignored' }).input.texts, []);
});

test('nested or non-string text parts are ignored', () => {
  assert.deepEqual(pre('write', { filePath: 'a.txt', content: { parts: [{ text: 'nested' }] } }).input.texts, []);
  assert.deepEqual(pre('edit', { filePath: 'a.txt', oldString: ['x'], newString: 'y' }).input.texts, [{ key: ['newString'], value: 'y' }]);
  assert.deepEqual(pre('write', { filePath: 'a.txt', content: '' }).input.texts, [{ key: ['content'], value: '' }]);
  assert.deepEqual(pre('write', { filePath: 'a.txt' }).input.texts, []);
});
