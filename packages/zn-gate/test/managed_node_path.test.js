'use strict';

// `zn team managed-config --zn-path P --node-path N`: the managed hook runs Node.js only from N. A fake `node` earlier on the
// PATH (and not next to zn) used to be the node zn ran under.

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
const BS = String.fromCharCode(92);
const SYS_NODE = ['/usr/bin/node', '/usr/local/bin/node', '/bin/node'].find((p) => fs.existsSync(p));
const REAL_ZN = ['/usr/bin/false', '/bin/false'].find((p) => fs.existsSync(p));

// A zn that records which node it runs under, and a directory with a real node and one with a fake node.
function setup(t) {
  const dir = tempDir(t, 'zn-b2193-');
  for (const d of ['znbin', 'realnode', 'fake', 'out']) fs.mkdirSync(path.join(dir, d));
  const zn = path.join(dir, 'znbin', 'zn');
  fs.writeFileSync(zn, '#!/bin/sh\ncommand -v node > "' + path.join(dir, 'out', 'node') + '"\nexit 0\n', { mode: 0o755 });
  const realNode = path.join(dir, 'realnode', 'node');
  fs.symlinkSync(process.execPath, realNode);
  fs.writeFileSync(path.join(dir, 'fake', 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { dir, zn, realNode, seen: () => (fs.existsSync(path.join(dir, 'out', 'node')) ? fs.readFileSync(path.join(dir, 'out', 'node'), 'utf8').trim() : null) };
}

function run(command, dir) {
  const env = { PATH: path.join(dir, 'fake') + ':/usr/bin:/bin', HOME: path.join(dir, 'out') };
  return spawnSync('sh', ['-c', command], { env, encoding: 'utf8', input: '{}' }).status;
}

test('a fake node earlier on the PATH is used without --node-path and refused with it', { skip: !posix }, (t) => {
  const s = setup(t);
  // Only zn pinned: its folder goes first, but node is not there, so the fake node earlier on the PATH is the one found.
  assert.equal(run(launcher.projectShCommand('claude-code', 'PreToolUse', { znPath: s.zn }), s.dir), 0);
  assert.equal(s.seen(), path.join(s.dir, 'fake', 'node'));
  fs.rmSync(path.join(s.dir, 'out', 'node'));
  // Node pinned: zn runs with exactly that node first on the PATH.
  assert.equal(run(launcher.projectShCommand('claude-code', 'PreToolUse', { znPath: s.zn, nodePath: s.realNode }), s.dir), 0);
  assert.equal(s.seen(), s.realNode);
  fs.rmSync(path.join(s.dir, 'out', 'node'));
  // Pinned node missing: nothing else is picked up; zn is not run and the hook blocks.
  fs.rmSync(s.realNode);
  const status = run(launcher.projectShCommand('claude-code', 'PreToolUse', { znPath: s.zn, nodePath: s.realNode }), s.dir);
  assert.equal(status, 2);
  assert.equal(s.seen(), null);
});

test('a pinned node that is not named node, or that has an odd shape, is refused by the launcher', () => {
  assert.throws(() => launcher.projectShCommand('claude-code', 'PreToolUse', { znPath: '/usr/local/bin/zn', nodePath: '/usr/local/bin/other' }), /unsafe node path/);
  assert.throws(() => launcher.projectShCommand('claude-code', 'PreToolUse', { znPath: '/usr/local/bin/zn', nodePath: '/opt/a b/../node' }), /unsafe node path/);
  assert.throws(() => launcher.projectShCommand('claude-code', 'PreToolUse', { znPath: '/usr/local/bin/zn', nodePath: '/opt/n";id;"/node' }), /unsafe node path/);
});

test('the hook with a pinned node is still zn\'s own for every agent and system', () => {
  const zp = 'C:' + BS + 'Program Files' + BS + 'zn' + BS + 'zn.cmd';
  const np = 'C:' + BS + 'Program Files' + BS + 'nodejs' + BS + 'node.exe';
  for (const agent of ['claude-code', 'cursor', 'codex']) {
    const [f] = mc.build({ agent, os: 'windows', znPath: zp, nodePath: np });
    let n = 0;
    for (const m of f.content.matchAll(/(?:command|command_windows)\W+(?:=|:)\s*"((?:[^"\\]|\\.)*)"/g)) {
      n++;
      assert.ok(cfg.isOurs(JSON.parse('"' + m[1] + '"'), agent), agent);
    }
    assert.ok(n >= 1, agent);
  }
  const [lin] = mc.build({ agent: 'claude-code', os: HOST_OS === 'linux' ? 'macos' : 'linux', znPath: '/opt/zn/bin/zn', nodePath: '/opt/node/bin/node' });
  const command = JSON.parse(lin.content).hooks.PreToolUse[0].hooks[0].command;
  assert.ok(cfg.isOurs(command, 'claude-code'));
  assert.ok(command.includes('X="/opt/node/bin/node"'));
  assert.match(lin.notes.join('\n'), /Node\.js is run only from exactly \/opt\/node\/bin\/node/);
});

test('windows: the script puts the node folder first and requires node.exe to be exactly that file', () => {
  const zp = 'C:' + BS + 'Program Files' + BS + 'zn' + BS + 'zn.cmd';
  const np = 'C:' + BS + 'Program Files' + BS + 'nodejs' + BS + 'node.exe';
  const script = launcher.projectWindowsScript('cursor', 'beforeReadFile', { znPath: zp, nodePath: np });
  assert.ok(script.includes("$env:PATH = 'C:" + BS + 'Program Files' + BS + 'nodejs;C:' + BS + 'Program Files' + BS + "zn;' + $env:PATH"));
  assert.ok(script.includes("([System.IO.File]::Exists('" + np + "')) -and ((zf 'node.exe') -eq '" + np + "')"));
  assert.ok(!script.includes('node.cmd'));
  assert.throws(() => launcher.projectWindowsScript('cursor', 'beforeReadFile', { znPath: zp, nodePath: 'C:' + BS + 'x' + BS + 'node.cmd' }), /unsafe node path/);
});

test('validation: shape, other system, and --node-path needs --zn-path and one --os', (t) => {
  const bad = (p, os, re) => assert.throws(() => mc.checkZnPath(p, os, '--node-path'), re);
  bad('node', 'linux', /--node-path must be an absolute path to the node program/);
  bad('/usr/local/bin/zn', 'linux', /absolute path to the node program/);
  bad('/usr/local/../bin/node', 'linux', /absolute path/);
  bad('/usr/bin/node; id', 'linux', /absolute path/);
  bad('C:' + BS + 'nodejs' + BS + 'node.cmd', 'windows', /node\.exe/);
  bad('/usr/bin/node', 'windows', /node\.exe/);
  bad('', 'linux', /--node-path needs a value/);
  const other = HOST_OS === 'linux' ? 'macos' : 'linux';
  assert.deepEqual(mc.checkZnPath('/opt/node/bin/node', other, '--node-path'), { path: '/opt/node/bin/node', os: other, checked: false });
  assert.throws(() => mc.build({ os: 'linux', nodePath: '/usr/bin/node' }), /--node-path needs --zn-path too/);
  assert.throws(() => mc.build({ os: 'all', znPath: '/opt/zn/bin/zn', nodePath: '/opt/node/bin/node' }), /also pass --os/);
  if (posix) {
    assert.throws(() => mc.checkZnPath('/no/such/node', HOST_OS, '--node-path'), /--node-path \/no\/such\/node does not exist/);
    assert.throws(() => mc.checkZnPath('/usr', HOST_OS, '--node-path'), /absolute path to the node program/);
    // A node in the temp folder is a folder a user can write to.
    const dir = tempDir(t, 'zn-b2193-');
    const n = path.join(dir, 'node');
    fs.writeFileSync(n, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.throws(() => mc.checkZnPath(n, HOST_OS, '--node-path'), /--node-path .* folder a user can write to/);
    fs.chmodSync(n, 0o644);
    assert.throws(() => mc.checkZnPath(n, HOST_OS, '--node-path'), /not executable/);
    if (SYS_NODE && fs.realpathSync(SYS_NODE).startsWith('/usr/')) {
      assert.deepEqual(mc.checkZnPath(SYS_NODE, HOST_OS, '--node-path'), { path: SYS_NODE, os: HOST_OS, checked: true });
    }
  }
});

test('command line: --node-path works with --zn-path and exits 2 without it', { skip: !posix || !REAL_ZN || !SYS_NODE }, () => {
  const cli = path.join(__dirname, '..', 'bin', 'cli.js');
  const bad = spawnSync(process.execPath, [cli, 'team', 'managed-config', '--os', HOST_OS, '--node-path', SYS_NODE], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--node-path needs --zn-path too/);
  const none = spawnSync(process.execPath, [cli, 'team', 'managed-config', '--node-path'], { encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--node-path needs a value/);
  // The node and zn must not be named alike in a user-writable place: REAL_ZN (a system file) stands in for zn; the node
  // must itself pass the checks, so this only runs when a system node exists.
  if (fs.realpathSync(SYS_NODE).startsWith('/usr/')) {
    const ok = spawnSync(process.execPath, [cli, 'team', 'managed-config', '--agent', 'claude-code', '--os', HOST_OS, '--zn-path', REAL_ZN, '--node-path', SYS_NODE, '--json'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(JSON.parse(ok.stdout).files[0].content.includes('X=\\"' + SYS_NODE + '\\"'));
  }
});
