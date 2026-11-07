'use strict';
// Shell name detection in the OpenCode adapter.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isPowerShellName, usesPowerShell } = require('../lib/agents/opencode');

test('isPowerShellName accepts powershell, pwsh and pwsh-preview in any case', () => {
  for (const n of ['powershell', 'PowerShell', 'pwsh', 'PWSH', 'pwsh-preview', 'Pwsh-Preview']) {
    assert.equal(isPowerShellName(n), true, n);
  }
});

test('isPowerShellName ignores a .exe suffix', () => {
  for (const n of ['powershell.exe', 'PowerShell.EXE', 'pwsh.exe', 'pwsh-preview.exe']) {
    assert.equal(isPowerShellName(n), true, n);
  }
});

test('isPowerShellName reads the base name of POSIX and Windows paths', () => {
  const paths = [
    '/usr/bin/pwsh',
    '/opt/microsoft/powershell/7/pwsh-preview',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ];
  for (const p of paths) assert.equal(isPowerShellName(p), true, p);
});

test('isPowerShellName rejects other shells and near misses', () => {
  for (const n of ['bash', 'sh', 'zsh', 'cmd.exe', 'pwsh-lts', 'mypwsh', 'powershell-core', '/usr/bin/bash', 'C:\\Git\\bin\\bash.exe']) {
    assert.equal(isPowerShellName(n), false, n);
  }
});

test('a missing or non-string shell has an empty base name', () => {
  assert.equal(isPowerShellName(undefined), false);
  assert.equal(isPowerShellName(''), false);
  assert.equal(isPowerShellName(null), false);
  assert.equal(isPowerShellName(42), false);
});

test('usesPowerShell is true for a PowerShell name on every platform', () => {
  for (const platform of ['win32', 'linux', 'darwin', undefined]) {
    assert.equal(usesPowerShell('pwsh', platform), true, String(platform));
    assert.equal(usesPowerShell('/usr/bin/pwsh-preview', platform), true, String(platform));
    assert.equal(usesPowerShell('PowerShell.exe', platform), true, String(platform));
  }
});

test('usesPowerShell on win32 is true for any shell that is not bash-like', () => {
  for (const s of ['cmd.exe', 'fish', 'nu', 'C:\\Windows\\System32\\cmd.exe']) {
    assert.equal(usesPowerShell(s, 'win32'), true, s);
  }
});

test('usesPowerShell on win32 treats a missing shell as PowerShell', () => {
  assert.equal(usesPowerShell(undefined, 'win32'), true);
  assert.equal(usesPowerShell('', 'win32'), true);
});

test('usesPowerShell on win32 is false for bash-like shells', () => {
  for (const s of ['bash', 'sh', 'zsh', 'dash', 'ksh', 'BASH.EXE', '/bin/zsh', 'C:\\Program Files\\Git\\bin\\bash.exe']) {
    assert.equal(usesPowerShell(s, 'win32'), false, s);
  }
});

test('usesPowerShell off Windows only counts an explicit PowerShell name', () => {
  for (const platform of ['linux', 'darwin']) {
    for (const s of ['bash', 'zsh', 'fish', 'cmd.exe', '', undefined]) {
      assert.equal(usesPowerShell(s, platform), false, `${platform} ${s}`);
    }
  }
});
