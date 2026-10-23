'use strict';

// The launcher script runs the runner only if the runner still has the SHA-256 recorded at install time.
// A stub that exits 0, an edited file, or a runner replaced by a package update must be blocked (not run, not
// passed through), with a message that says zn-gate changed and how to fix it. A `zn` found on the PATH is
// never run in its place. Values are fake; everything runs in a temporary home with the real `sh`.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter } = require('../lib/agents');
const launcher = require('../lib/agents/launcher');
const { check } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const claude = getAdapter('claude-code');
const posix = process.platform !== 'win32';
const SUM = ['/usr/bin/sha256sum', '/bin/sha256sum'].find((f) => fs.existsSync(f));
const REAL = "process.stdout.write('REAL_RUNNER\\n'); process.exit(0);\n";
const CHANGED = /zn-gate changed since the hooks were installed/;
const AGAIN = /zn hooks install claude-code/;

function setup(t, nodePath = process.execPath) {
  const home = tempDir(t, 'zn-b1174-');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
  const runner = path.join(tempDir(t, 'zn-b1174-pkg-'), 'runner.js');
  fs.writeFileSync(runner, REAL);
  const install = (node = nodePath) => claude.install({ env, home, nodePath: node, runnerPath: runner, mcp: false });
  install();
  return { home, env, runner, install, file: launcher.launcherFile('claude-code', { env, home }) };
}

function run(file, event, pathValue = process.env.PATH, cwd) {
  return spawnSync('/bin/sh', [file, event], { input: '{}', encoding: 'utf8', cwd, env: { PATH: pathValue, HOME: '/nonexistent' } });
}

test('integrity: the intact runner runs normally', { skip: !posix }, (t) => {
  const { file } = setup(t);
  const r = run(file, 'PreToolUse');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'REAL_RUNNER');
});

test('integrity: the launcher records the SHA-256 of the runner', { skip: !posix }, (t) => {
  const { file, runner } = setup(t);
  assert.match(fs.readFileSync(file, 'utf8'), new RegExp("^ZN_SHA='" + launcher.runnerSha(runner) + "'$", 'm'));
  assert.match(launcher.runnerSha(runner), /^[0-9a-f]{64}$/);
});

test('integrity: a stub runner that exits 0 is blocked with the new reason, not passed through', { skip: !posix }, (t) => {
  const { file, runner } = setup(t);
  fs.writeFileSync(runner, 'process.exit(0);\n');
  const r = run(file, 'PreToolUse');
  assert.equal(r.status, 2);
  assert.match(r.stderr, CHANGED);
  assert.match(r.stderr, AGAIN);
  assert.doesNotMatch(r.stderr, /are gone/, 'a distinct reason, not the "gone" text');
  for (const ev of ['UserPromptSubmit', 'UserPromptExpansion']) assert.equal(run(file, ev).status, 2, ev);
});

test('integrity: an edited runner is blocked', { skip: !posix }, (t) => {
  const { file, runner } = setup(t);
  fs.appendFileSync(runner, '// one more line\n');
  const r = run(file, 'PreToolUse');
  assert.equal(r.status, 2);
  assert.match(r.stderr, CHANGED);
});

test('integrity: after the tool ran (PostToolUse) a changed runner only warns, with the reinstall step', { skip: !posix }, (t) => {
  const { file, runner } = setup(t);
  fs.writeFileSync(runner, 'process.exit(0);\n');
  const r = run(file, 'PostToolUse');
  assert.equal(r.status, 0);
  const msg = JSON.parse(r.stdout).systemMessage;
  assert.match(msg, CHANGED);
  assert.match(msg, AGAIN);
});

test('integrity: an updated package (a new runner) is blocked with the reinstall message until the hooks are installed again', { skip: !posix }, (t) => {
  const { file, runner, install } = setup(t);
  fs.writeFileSync(runner, "process.stdout.write('NEW_VERSION\\n'); process.exit(0);\n");
  const blocked = run(file, 'PreToolUse');
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, CHANGED);
  assert.match(blocked.stderr, AGAIN);
  install(); // `zn hooks install claude-code`
  const ok = run(file, 'PreToolUse');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), 'NEW_VERSION');
});

test('integrity: no hash tool available: blocked, never run unverified', { skip: !posix }, (t) => {
  const { file } = setup(t);
  const empty = tempDir(t, 'zn-b1174-empty-');
  const r = run(file, 'PreToolUse', empty);
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stdout, /REAL_RUNNER/);
  assert.match(r.stderr, CHANGED);
});

test('integrity: shasum or openssl alone is enough to verify', { skip: !posix || !SUM }, (t) => {
  const { file } = setup(t);
  const shasum = tempDir(t, 'zn-b1174-shasum-');
  fs.writeFileSync(path.join(shasum, 'shasum'), '#!/bin/sh\nexec ' + SUM + '\n', { mode: 0o755 });
  assert.equal(run(file, 'PreToolUse', shasum).stdout.trim(), 'REAL_RUNNER');
  const ossl = tempDir(t, 'zn-b1174-openssl-');
  fs.writeFileSync(path.join(ossl, 'openssl'), '#!/bin/sh\n' + SUM + ' | sed "s/^/SHA2-256(stdin)= /"\n', { mode: 0o755 });
  // sed is looked up in the PATH of the shim, which is the safe PATH of the launcher: add the system dirs after it.
  assert.equal(run(file, 'PreToolUse', ossl + ':/usr/bin:/bin').stdout.trim(), 'REAL_RUNNER');
});

test('integrity: a wrong answer from a hash tool is a mismatch', { skip: !posix }, (t) => {
  const { file } = setup(t);
  const fake = tempDir(t, 'zn-b1174-fake-');
  fs.writeFileSync(path.join(fake, 'sha256sum'), '#!/bin/sh\necho "0000000000000000000000000000000000000000000000000000000000000000  -"\n', { mode: 0o755 });
  const r = run(file, 'PreToolUse', fake);
  assert.equal(r.status, 2);
  assert.match(r.stderr, CHANGED);
});

test('integrity: a fake zn on an absolute PATH entry is not run when the recorded Node.js is gone', { skip: !posix }, (t) => {
  const { home, file } = setup(t, '/nonexistent/node-gone/bin/node');
  const bin = tempDir(t, 'zn-b1174-bin-');
  const mark = path.join(home, 'fake-zn-ran');
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'zn'), '#!/bin/sh\ntouch ' + mark + '\nexit 0\n', { mode: 0o755 });
  const r = run(file, 'PreToolUse', bin);
  assert.equal(r.status, 2);
  assert.equal(fs.existsSync(mark), false, 'the fake zn must not run');
});

test('check: reports a launcher whose runner no longer matches the recorded SHA-256', { skip: !posix }, async (t) => {
  const { home, env, runner } = setup(t);
  // Give the check a runner that really answers, so that only the digest tells the difference.
  const real = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');
  claude.install({ env, home, nodePath: process.execPath, runnerPath: real, mcp: false });
  let r = (await check({ home, env, cwd: tempDir(t, 'zn-b1174-cwd-') })).results.find((x) => x.id === 'claude-code');
  assert.equal(r.state, 'protected', r.problem);
  // The runner of that install changes (an update): same path, other bytes.
  const copy = path.join(path.dirname(runner), 'runner2.js');
  fs.writeFileSync(copy, fs.readFileSync(real));
  claude.install({ env, home, nodePath: process.execPath, runnerPath: copy, mcp: false });
  fs.appendFileSync(copy, '\n// changed after install\n');
  r = (await check({ home, env, cwd: tempDir(t, 'zn-b1174-cwd-') })).results.find((x) => x.id === 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /zn-gate changed since the hooks were installed/);
  assert.match(r.fix, /zn hooks install claude-code/);
});
