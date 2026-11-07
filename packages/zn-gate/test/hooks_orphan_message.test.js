'use strict';

// After `npm uninstall -g zn-gate` the hook entries and the launcher in the user's .zn folder stay on disk, but the
// runner and the Node.js they point at are gone. The launcher must then say what happened and the one fix, and it must
// block where the agent documents a block. Values are fake; the real `sh` runs with an empty folder as the PATH.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const launcher = require('../lib/agents/launcher');
const { tempDir } = require('./helpers/tmp');

const posix = process.platform !== 'win32';
const AGENTS = ['claude-code', 'codex', 'cursor', 'gemini', 'zcode'];

function orphan(t, agent) {
  const home = tempDir(t, 'zn-orphan-hook-');
  const empty = path.join(home, 'empty');
  fs.mkdirSync(empty);
  const env = { HOME: home, ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
  // The package is gone: neither the Node.js nor the runner recorded at install time exists.
  const file = launcher.writeLauncher(agent, path.join(home, 'gone', 'node'), path.join(home, 'gone', 'zn-gate', 'runner.js'), { env, home });
  return (event) => spawnSync('/bin/sh', [file, event], { input: '{}', encoding: 'utf8', env: { PATH: empty, HOME: '/nonexistent' } });
}

for (const agent of AGENTS) {
  test('orphan hook (' + agent + '): a blocking event is blocked with the reason and both fixes', { skip: !posix }, (t) => {
    const run = orphan(t, agent);
    const event = [...launcher.blockExit(agent)][0];
    const r = run(event);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /zn-gate is not installed any more/);
    assert.match(r.stderr, /hooks for /);
    assert.match(r.stderr, /still point at it/);
    assert.match(r.stderr, new RegExp('npm install -g zn-gate` and then `zn hooks install ' + agent));
    assert.match(r.stderr, new RegExp('npx -y zn-gate hooks uninstall ' + agent));
    // Node.js may be the missing part: the text must say to reinstall it before any npm or npx command.
    assert.ok(r.stderr.indexOf('install Node.js again') !== -1 && r.stderr.indexOf('install Node.js again') < r.stderr.indexOf('npm install -g'), r.stderr);
    assert.match(r.stderr, /once Node\.js is installed, remove the hooks/);
  });

  test('orphan hook (' + agent + '): an event that cannot block only warns, with the same fixes', { skip: !posix }, (t) => {
    const run = orphan(t, agent);
    const r = run('PostToolUse');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = r.stdout + r.stderr;
    assert.match(out, /zn-gate is not installed any more/);
    assert.match(out, /npm install -g zn-gate/);
    assert.match(out, new RegExp('npx -y zn-gate hooks uninstall ' + agent));
  });
}

test('orphan hook: the Windows script carries the same text', () => {
  const s = launcher.windowsScript('codex', 'PreToolUse', 'C:/gone/node.exe', 'C:/gone/runner.js');
  assert.ok(s, 'a script is made');
  assert.match(s, /zn-gate is not installed any more/);
  assert.match(s, /npx.cmd -y zn-gate hooks uninstall codex/);
  assert.match(s, /install Node\.js again/);
  assert.match(s, /exit 2/);
});
