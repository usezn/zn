'use strict';

// lib/agents/launcher.js: a folder name with spaces or quotes must reach the
// hook command as one word on POSIX and Windows command lines. Values are fake.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const launcher = require('../lib/agents/launcher');

const posix = process.platform !== 'win32';
const NAMES = ['my folder/zn-hook-codex.sh', "it's here/zn-hook-codex.sh", 'say "hi"/zn-hook-codex.sh', 'a  b $HOME `x`/zn-hook-codex.sh'];

test('launcherCommand quotes a POSIX path with spaces as one word', () => {
  const cmd = launcher.launcherCommand('/home/user/my folder/zn-hook-codex.sh', 'PreToolUse', 'linux');
  assert.equal(cmd, "'/home/user/my folder/zn-hook-codex.sh' PreToolUse");
});

test('launcherCommand keeps a double quote and a dollar sign inside single quotes', () => {
  const cmd = launcher.launcherCommand('/home/user/say "hi" $HOME/zn-hook-codex.sh', 'PreToolUse', 'linux');
  assert.equal(cmd, "'/home/user/say \"hi\" $HOME/zn-hook-codex.sh' PreToolUse");
});

test('launcherCommand escapes a single quote in a POSIX path', () => {
  const cmd = launcher.launcherCommand("/home/user/it's here/zn-hook-codex.sh", 'PreToolUse', 'linux');
  assert.equal(cmd, "'/home/user/it'\"'\"'s here/zn-hook-codex.sh' PreToolUse");
});

test('launcherCommand writes a Windows path with forward slashes and quotes the spaces', () => {
  const cmd = launcher.launcherCommand('C:\\Users\\Jo Doe\\.zn\\hooks\\zn-hook-codex.sh', 'PreToolUse', 'win32');
  assert.equal(cmd, "'C:/Users/Jo Doe/.zn/hooks/zn-hook-codex.sh' PreToolUse");
});

test('launcherCommand escapes a single quote in a Windows path', () => {
  const cmd = launcher.launcherCommand("C:\\Users\\O'Neil\\hooks\\zn-hook-codex.sh", 'PreToolUse', 'win32');
  assert.equal(cmd, "'C:/Users/O'\"'\"'Neil/hooks/zn-hook-codex.sh' PreToolUse");
});

test('launcherCommand keeps a backslash as a file name character on POSIX', () => {
  const cmd = launcher.launcherCommand('/home/user/a\\b/zn-hook-codex.sh', 'PreToolUse', 'linux');
  assert.ok(!cmd.includes('a/b'), cmd);
  assert.ok(cmd.includes('a'), cmd);
});

test('launcherCommand with plain:true writes no quotes', () => {
  assert.equal(launcher.launcherCommand('/opt/zn/zn-hook-x.sh', 'Ev', 'linux', { plain: true }), '/opt/zn/zn-hook-x.sh Ev');
  assert.equal(launcher.launcherCommand('C:\\zn\\h.sh', 'Ev', 'win32', { plain: true }), 'C:/zn/h.sh Ev');
});

test('plainPathOk accepts simple paths and refuses spaces and quotes', () => {
  assert.equal(launcher.plainPathOk('/opt/zn/hooks/zn-hook-x.sh'), true);
  assert.equal(launcher.plainPathOk('/opt/my folder/x.sh'), false);
  assert.equal(launcher.plainPathOk("/opt/it's/x.sh"), false);
  assert.equal(launcher.plainPathOk('/opt/say"hi"/x.sh'), false);
  assert.equal(launcher.plainPathOk(''), false);
});

test('a quoted launcher command is read back by sh as the exact path and the event', { skip: !posix }, () => {
  for (const name of NAMES) {
    const file = path.posix.join('/tmp/zn-example', name);
    const cmd = launcher.launcherCommand(file, 'PreToolUse', 'linux');
    const r = spawnSync('/bin/sh', ['-c', 'printf "%s\\n" ' + cmd], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split('\n').slice(0, 2), [file, 'PreToolUse']);
  }
});

test('unixScript quotes node and runner paths with spaces and quotes as single words', { skip: !posix }, () => {
  const script = launcher.unixScript('codex', "/opt/my node/it's/node", '/opt/my "dir"/runner.js');
  assert.ok(script.includes("ZN_NODE='/opt/my node/it'\"'\"'s/node'"), script);
  assert.ok(script.includes("ZN_RUNNER='/opt/my \"dir\"/runner.js'"), script);
  const r = spawnSync('/bin/sh', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('windowsScript keeps spaces in paths and returns null for a single quote', () => {
  const s = launcher.windowsScript('codex', 'PreToolUse', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Jo Doe\\runner.js');
  assert.ok(s.includes("'C:/Program Files/nodejs/node.exe'"), s);
  assert.ok(s.includes("'C:/Users/Jo Doe/runner.js'"), s);
  assert.ok(s.endsWith('# zn hook codex'), s);
  assert.equal(launcher.windowsScript('codex', 'PreToolUse', 'C:\\O\'Neil\\node.exe', 'C:\\r.js'), null);
  assert.equal(launcher.windowsScript('codex', 'PreToolUse', 'C:\\n.exe', 'C:\\\u2019x\\r.js'), null);
});

test('windowsScriptCommand encodes a script with quotes so no quote is left on the command line', () => {
  const script = launcher.windowsScript('codex', 'PreToolUse', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Jo Doe\\runner.js');
  const cmd = launcher.windowsScriptCommand(script);
  assert.match(cmd, /^C:\/Windows\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  const b64 = cmd.split(' ').pop();
  assert.equal(Buffer.from(b64, 'base64').toString('utf16le'), script);
});
