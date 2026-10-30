'use strict';

// `zn team managed-config --zn-path`: the managed hook runs zn at one absolute path and never the first `zn` on the user's PATH.
// A fake zn earlier on the PATH used to turn the managed hook into "allow" without touching any settings file.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mc = require('../lib/team/managed-config');
const launcher = require('../lib/agents/launcher');
const cfg = require('../lib/agents/config-file');
const { tempDir } = require('./helpers/tmp');

const posix = process.platform !== 'win32';
const HOST_OS = process.platform === 'darwin' ? 'macos' : 'linux';
// A program in a folder only root can write to, that exits non-zero (so a hook that really runs it is not "allow").
const REAL = ['/usr/bin/false', '/bin/false'].find((p) => fs.existsSync(p));
const NODE_DIR = path.dirname(process.execPath);
const BS = String.fromCharCode(92);

function claudeHook(opts, event = 'PreToolUse') {
  const f = mc.build({ agent: 'claude-code', os: HOST_OS, ...opts }).find((x) => x.file.endsWith('managed-settings.json'));
  return { file: f, command: JSON.parse(f.content).hooks[event][0].hooks[0].command };
}

function runHook(command, fakeDir) {
  const env = { PATH: fakeDir + ':' + NODE_DIR + ':/usr/bin:/bin', HOME: path.join(fakeDir, 'home') };
  return spawnSync('sh', ['-c', command], { env, encoding: 'utf8', input: '{}' }).status;
}

test('PATH shadowing: a fake zn earlier on the PATH is obeyed without --zn-path, and not with it', { skip: !posix || !REAL }, (t) => {
  const dir = tempDir(t, 'zn-b2121-');
  fs.mkdirSync(path.join(dir, 'home'));
  fs.writeFileSync(path.join(dir, 'zn'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // Before: the default hook finds the fake zn first and the managed hook allows everything.
  assert.equal(runHook(claudeHook({}).command, dir), 0);
  // With the fixed path the same PATH changes nothing: the real program runs (it exits 1, which the guard turns into a block).
  const pinned = claudeHook({ znPath: REAL });
  assert.ok(pinned.command.includes('Z="' + REAL + '"'));
  assert.ok(!pinned.command.includes('command -v zn'));
  assert.equal(runHook(pinned.command, dir), 2);
});

test('the pinned hook is still recognized as zn\'s own for every agent and system', () => {
  for (const agent of ['claude-code', 'cursor', 'codex']) {
    const f = mc.build({ agent, os: 'windows', znPath: 'C:' + BS + 'Program Files' + BS + 'nodejs' + BS + 'zn.cmd' });
    assert.equal(f.length, 1);
    let n = 0;
    for (const m of f[0].content.matchAll(/(?:command|command_windows)\W+(?:=|:)\s*"((?:[^"\\]|\\.)*)"/g)) {
      n++;
      assert.ok(cfg.isOurs(JSON.parse('"' + m[1] + '"'), agent), agent + ': ' + m[1].slice(0, 60));
    }
    assert.ok(n >= 1, agent);
  }
  if (REAL) {
    const { command } = claudeHook({ znPath: REAL });
    assert.ok(launcher.isProjectGuard(command, 'claude-code'));
    assert.ok(cfg.isOurs(command, 'claude-code'));
  }
});

test('windows: the hook names the exact file and puts its folder first; claude code gets the Git Bash form', () => {
  const zp = 'C:' + BS + 'Program Files' + BS + 'nodejs' + BS + 'zn.cmd';
  const script = launcher.projectWindowsScript('cursor', 'beforeReadFile', { znPath: zp });
  assert.ok(script.includes("& '" + zp + "' hook cursor;"));
  assert.ok(script.includes("$env:PATH = 'C:" + BS + 'Program Files' + BS + "nodejs;' + $env:PATH"));
  assert.ok(!script.includes("(zf 'zn.cmd')"));
  const [claude] = mc.build({ agent: 'claude-code', os: 'windows', znPath: zp });
  assert.match(claude.content, /Z=\\"\/c\/Program Files\/nodejs\/zn\.cmd\\"/);
  assert.match(claude.notes.join('\n'), /not checked on this computer|checked on this computer/);
});

test('without --zn-path nothing changes in the files and a note recommends the flag', () => {
  const plain = mc.build({ agent: 'claude-code', os: 'linux' });
  assert.match(plain[0].content, /command -v zn/);
  assert.match(plain[0].notes.join('\n'), /--zn-path/);
});

test('a pinned path also goes into the optional managed MCP file', { skip: !posix || !REAL }, () => {
  const files = mc.build({ agent: 'claude-code', os: HOST_OS, exclusiveMcp: true, znPath: REAL });
  const mcp = files.find((f) => f.file.endsWith('managed-mcp.json'));
  assert.equal(JSON.parse(mcp.content).mcpServers.secrets.command, REAL);
});

test('validation: shape', () => {
  const bad = (p, os, re) => assert.throws(() => mc.checkZnPath(p, os), re);
  bad('zn', 'linux', /absolute path/);
  bad('./zn', 'linux', /absolute path/);
  bad('/usr/local/../bin/zn', 'linux', /absolute path/);
  bad('/usr/local/bin/zn; rm -rf /', 'linux', /absolute path/);
  bad('/usr/local/bin/z"n', 'linux', /absolute path/);
  bad('/usr/local/bin/$(id)', 'linux', /absolute path/);
  bad('C:' + BS + 'tools' + BS + 'zn.sh', 'windows', /zn\.cmd or zn\.exe/);
  bad('zn.cmd', 'windows', /zn\.cmd or zn\.exe/);
  bad('/usr/local/bin/zn', 'windows', /zn\.cmd or zn\.exe/);
  bad('', 'linux', /needs a value/);
});

test('validation: the file itself, on the system this runs on', { skip: !posix }, (t) => {
  assert.throws(() => mc.checkZnPath('/no/such/dir/zn', HOST_OS), /does not exist/);
  assert.throws(() => mc.checkZnPath('/usr', HOST_OS), /not a file/);
  // A regular file that is not executable, and one in the temp folder or the project folder (a place a user writes to).
  const dir = tempDir(t, 'zn-b2121-');
  const plain = path.join(dir, 'zn');
  fs.writeFileSync(plain, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  assert.throws(() => mc.checkZnPath(plain, HOST_OS), /not executable/);
  fs.chmodSync(plain, 0o755);
  assert.throws(() => mc.checkZnPath(plain, HOST_OS), /folder a user can write to/);
  // The folder the command runs in (the project) counts, whatever it is called.
  const here = tempDir(t, 'zn-b2121-', path.join(__dirname, '..'));
  const inCwd = path.join(here, 'zn');
  fs.writeFileSync(inCwd, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.throws(() => mc.checkZnPath(inCwd, HOST_OS), /folder a user can write to/);
  // A symlink into the temp folder is judged by where it points.
  const link = path.join(dir, 'link');
  fs.symlinkSync(plain, link);
  assert.throws(() => mc.checkZnPath(link, HOST_OS), /folder a user can write to/);
  // A file the current user owns is refused even outside the home, temp and project folders (like Homebrew in /opt/homebrew).
  const shm = '/dev/shm';
  if (process.getuid && process.getuid() !== 0 && fs.existsSync(shm)) {
    const mine = path.join(shm, 'zn-b2121-' + process.pid);
    fs.mkdirSync(mine, { mode: 0o755 });
    t.after(() => fs.rmSync(mine, { recursive: true, force: true }));
    fs.writeFileSync(path.join(mine, 'zn'), '#!/bin/sh'+String.fromCharCode(10)+'exit 0'+String.fromCharCode(10), { mode: 0o755 });
    assert.throws(() => mc.checkZnPath(path.join(mine, 'zn'), HOST_OS), /not owned by root/);
  }
  // A system program passes.
  if (REAL) assert.deepEqual(mc.checkZnPath(REAL, HOST_OS), { path: REAL, os: HOST_OS, checked: true });
});

test('--zn-path needs one system, and a path for another system is shape-checked only', () => {
  assert.throws(() => mc.build({ znPath: '/usr/local/bin/zn', os: 'all' }), /also pass --os/);
  const other = HOST_OS === 'linux' ? 'macos' : 'linux';
  assert.deepEqual(mc.checkZnPath('/opt/zn/bin/zn', other), { path: '/opt/zn/bin/zn', os: other, checked: false });
});

test('command line: the flag works, errors exit 2 with the message', { skip: !posix || !REAL }, () => {
  const cli = path.join(__dirname, '..', 'bin', 'cli.js');
  const ok = spawnSync(process.execPath, [cli, 'team', 'managed-config', '--agent', 'claude-code', '--os', HOST_OS, '--zn-path', REAL, '--json'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(JSON.parse(ok.stdout).files[0].content.includes(REAL));
  const bad = spawnSync(process.execPath, [cli, 'team', 'managed-config', '--os', HOST_OS, '--zn-path', 'zn'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^zn team managed-config: --zn-path must be an absolute path/);
  const none = spawnSync(process.execPath, [cli, 'team', 'managed-config', '--zn-path'], { encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--zn-path needs a value/);
});
