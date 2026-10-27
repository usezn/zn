'use strict';
/*
 * Edge cases of the OpenCode adapter helpers isPowerShellName, usesPowerShell
 * and respond: empty and non-string input, paths, case, boundary names, and
 * answers that must not change anything. Pure functions; no files are used.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const opencode = require('../lib/agents/opencode');

test('isPowerShellName: empty and non-string input is not PowerShell', () => {
  for (const v of [undefined, null, '', 0, 1, true, {}, [], ['pwsh']]) {
    assert.equal(opencode.isPowerShellName(v), false, String(JSON.stringify(v)));
  }
});

test('isPowerShellName: accepts the known names, any case, with .exe', () => {
  for (const v of ['powershell', 'PowerShell', 'POWERSHELL.EXE', 'pwsh', 'Pwsh.exe', 'pwsh-preview', 'pwsh-preview.exe']) {
    assert.equal(opencode.isPowerShellName(v), true, v);
  }
});

test('isPowerShellName: only the base name of a path counts', () => {
  assert.equal(opencode.isPowerShellName('/usr/local/bin/pwsh'), true);
  assert.equal(opencode.isPowerShellName('C:\\Windows\\System32\\powershell.exe'), true);
  assert.equal(opencode.isPowerShellName('/opt/pwsh/bin/bash'), false);
  assert.equal(opencode.isPowerShellName('/usr/bin/pwsh/'), false);
});

test('isPowerShellName: near misses are not PowerShell', () => {
  for (const v of ['pwsh7', 'pwsh-', 'pwsh-preview2', 'pwsh-daily', 'powershell_ise', 'powershell.exe.exe', 'xpwsh', ' pwsh', 'pwsh ', 'power shell', 'bash', 'cmd.exe']) {
    assert.equal(opencode.isPowerShellName(v), false, v);
  }
});

test('usesPowerShell: an explicit PowerShell name wins on every platform', () => {
  for (const p of ['linux', 'darwin', 'win32', undefined, '']) {
    assert.equal(opencode.usesPowerShell('pwsh', p), true, String(p));
  }
});

test('usesPowerShell: off Windows only a PowerShell name counts', () => {
  for (const p of ['linux', 'darwin', 'freebsd', undefined, null, '', 'WIN32']) {
    assert.equal(opencode.usesPowerShell('', p), false, String(p));
    assert.equal(opencode.usesPowerShell(undefined, p), false, String(p));
    assert.equal(opencode.usesPowerShell('fish', p), false, String(p));
    assert.equal(opencode.usesPowerShell('bash', p), false, String(p));
  }
});

test('usesPowerShell: on Windows an unset or unusable shell means PowerShell', () => {
  for (const s of [undefined, null, '', 42, {}, 'cmd', 'cmd.exe', 'fish', 'nu']) {
    assert.equal(opencode.usesPowerShell(s, 'win32'), true, String(JSON.stringify(s)));
  }
});

test('usesPowerShell: on Windows a bash-like shell is not PowerShell', () => {
  for (const s of ['bash', 'sh', 'zsh', 'dash', 'ksh', 'bash.exe', 'BASH.EXE', 'C:\\Program Files\\Git\\bin\\bash.exe', '/bin/zsh']) {
    assert.equal(opencode.usesPowerShell(s, 'win32'), false, s);
  }
  assert.equal(opencode.usesPowerShell('rbash', 'win32'), true);
});

test('respond: missing or malformed input answers none', () => {
  const none = { action: 'none' };
  for (const d of [undefined, null, 0, '', {}, { event: null }, { event: {} }, { event: { event: '' } }, { event: { event: null }, decision: 'deny' }]) {
    assert.deepEqual(opencode.respond(d), none, JSON.stringify(d));
  }
});

test('respond: deny blocks before-events and prompts, with a default message', () => {
  for (const e of ['pre_tool', 'user_prompt']) {
    assert.deepEqual(opencode.respond({ event: { event: e }, decision: 'deny', message: 'no' }), { action: 'deny', message: 'no' });
    assert.deepEqual(opencode.respond({ event: { event: e }, decision: 'deny' }), { action: 'deny', message: 'Blocked by zn' });
    assert.deepEqual(opencode.respond({ event: { event: e }, decision: 'deny', message: '' }), { action: 'deny', message: 'Blocked by zn' });
  }
});

test('respond: deny on a post_tool event is not a deny action', () => {
  assert.deepEqual(opencode.respond({ event: { event: 'post_tool' }, decision: 'deny', message: 'no' }), { action: 'none' });
});

test('respond: a wrap rewrite sets the command and texts, and nothing else', () => {
  const d = {
    event: { event: 'pre_tool' }, kind: 'wrap', message: 'wrapped',
    updatedInput: { command: 'zn run -- echo hi', texts: [{ key: ['content'], value: 'a' }, { key: ['newString'], value: 'b' }] },
  };
  assert.deepEqual(opencode.respond(d), { action: 'args', args: { command: 'zn run -- echo hi', content: 'a', newString: 'b' }, message: 'wrapped' });
});

test('respond: a wrap rewrite with an empty or non-string command', () => {
  const ev = { event: 'pre_tool' };
  assert.deepEqual(opencode.respond({ event: ev, kind: 'wrap', updatedInput: {} }), { action: 'args', args: {}, message: undefined });
  assert.deepEqual(opencode.respond({ event: ev, kind: 'wrap', updatedInput: { command: 5 } }), { action: 'args', args: {}, message: undefined });
  assert.deepEqual(opencode.respond({ event: ev, kind: 'wrap', updatedInput: { command: '' } }), { action: 'args', args: { command: '' }, message: undefined });
});

test('respond: rewrites that are not a wrap are never applied', () => {
  const ev = { event: 'pre_tool' };
  const updatedInput = { command: 'echo restored' };
  for (const kind of [undefined, 'restore', 'WRAP', '']) {
    assert.deepEqual(opencode.respond({ event: ev, kind, updatedInput }), { action: 'none' }, String(kind));
  }
  assert.deepEqual(opencode.respond({ event: ev, kind: 'wrap' }), { action: 'none' });
  assert.deepEqual(opencode.respond({ event: { event: 'user_prompt' }, kind: 'wrap', updatedInput }), { action: 'none' });
  assert.deepEqual(opencode.respond({ event: { event: 'post_tool' }, kind: 'wrap', updatedInput }), { action: 'none' });
});

test('respond: post_tool output rewrite passes output, content and metadata', () => {
  const ev = { event: 'post_tool' };
  const content = [{ type: 'text', text: 'x' }];
  assert.deepEqual(
    opencode.respond({ event: ev, updatedOutput: { output: 'o', content, metadata: { m: 1 } }, message: 'm' }),
    { action: 'output', output: 'o', content, metadata: { m: 1 }, message: 'm' });
  assert.deepEqual(opencode.respond({ event: ev, updatedOutput: {} }),
    { action: 'output', output: undefined, content: undefined, metadata: undefined, message: undefined });
  assert.deepEqual(opencode.respond({ event: ev, updatedOutput: { output: '' } }).output, '');
});

test('respond: no updatedOutput, or one on a pre_tool event, answers none', () => {
  assert.deepEqual(opencode.respond({ event: { event: 'post_tool' } }), { action: 'none' });
  assert.deepEqual(opencode.respond({ event: { event: 'pre_tool' }, updatedOutput: { output: 'o' } }), { action: 'none' });
});
