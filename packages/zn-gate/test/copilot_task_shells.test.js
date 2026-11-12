'use strict';

process.env.ZN_STATS = 'off';

// A task with a custom options.shell is accepted only for a known shell with that shell's own flags; any other
// pairing, and any error while reading a task, blocks it. Values are fictitious.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const copilot = require('../lib/agents/copilot');
const { tempDir } = require('./helpers/tmp');

const taskWith = (shell, extra) => ({
  task: Object.assign({ label: 'x', type: 'shell', command: 'echo hello', options: { shell } }, extra),
});
const scan = (shell, workspace) => copilot.commandScan(taskWith(shell), workspace);

test('a known shell with its own flags is accepted', (t) => {
  const ws = tempDir(t, 'zn-task-shell-');
  const ok = [
    { executable: 'bash', args: ['-c'] },
    { executable: '/bin/sh', args: ['-l', '-c'] },
    { executable: 'zsh', args: ['-i', '-c'] },
    { executable: 'dash', args: ['-c'] },
    { executable: 'fish', args: ['-c'] },
    { executable: 'nu', args: ['-c'] },
    { executable: 'pwsh', args: ['-NoProfile', '-Command'] },
    { executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NonInteractive', '-c'] },
    { executable: 'cmd', args: ['/d', '/s', '/c'] },
    { executable: 'CMD.EXE', args: ['/D', '/Q', '/C'] },
  ];
  for (const shell of ok) assert.equal(scan(shell, ws).bad, false, JSON.stringify(shell));
});

test('a known shell with another shell\'s flags is blocked', (t) => {
  const ws = tempDir(t, 'zn-task-shell-');
  const bad = [
    { executable: 'bash', args: ['/c', 'x'] },
    { executable: 'sh', args: ['/d', '/c'] },
    { executable: 'cmd', args: ['-c', 'x'] },
    { executable: 'pwsh', args: ['/c'] },
    { executable: 'powershell', args: ['-lc'] },
    { executable: 'fish', args: ['--login'] },
    { executable: 'bash', args: ['-noprofile'] },
    { executable: 'cmd', args: ['/c', '/x'] },
    { args: ['-c'] },
  ];
  for (const shell of bad) assert.equal(scan(shell, ws).bad, true, JSON.stringify(shell));
});

test('the home folder is resolved with HOME unset (os, path and fs are imported)', (t) => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  });
  delete process.env.HOME;
  process.env.USERPROFILE = tempDir(t, 'zn-task-home-');
  const ws = os.homedir();
  const input = { task: { label: 'x', type: 'shell', command: 'echo hello', options: { cwd: '${userHome}' } } };
  assert.equal(copilot.commandScan(input, ws).bad, false);
  const outside = { task: { label: 'x', type: 'shell', command: 'echo hello', options: { cwd: '${userHome}' } } };
  assert.equal(copilot.commandScan(outside, tempDir(t, 'zn-task-ws-')).bad, true);
});

test('an error while checking a task blocks it', () => {
  // A workspace that is not a path makes path.resolve throw inside the check; the task must not pass.
  const input = { task: { label: 'x', type: 'shell', command: 'echo hello', options: { cwd: '.' } } };
  assert.equal(copilot.commandScan(input, 42).bad, true);
});
