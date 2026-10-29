'use strict';
process.env.ZN_STATS = 'off';

// Programs zn starts by name (git inside hooks, an MCP server's command under `zn-gate shield`, sh for the Antigravity
// self-check) come from the absolute PATH entries only. The current folder of a hook or of shield is usually a project,
// which could hold a program of the same name; a relative or empty PATH entry points into it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const exe = require('../lib/exe');
const { tempDir } = require('./helpers/tmp');

const posix = { skip: process.platform === 'win32' };
const LIB = path.join(__dirname, '..', 'lib');

// A project folder with a program named `name` in it and in its bin folder; running either one creates the marker.
function planted(t, name) {
  const work = tempDir(t, 'zn-bare-work-');
  const marker = path.join(work, 'planted-ran');
  fs.mkdirSync(path.join(work, 'bin'));
  for (const d of [work, path.join(work, 'bin')]) fs.writeFileSync(path.join(d, name), '#!/bin/sh\n: > ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
  return { work, marker };
}

test('absolutePath keeps only the absolute PATH entries; findProgram looks only there', posix, (t) => {
  assert.equal(exe.absolutePath(['.', 'bin', '', '/usr/bin', '/x/', '..'].join(':')), '/usr/bin:/x/');
  const { work } = planted(t, 'zn-bare-tool');
  assert.equal(exe.findProgram('zn-bare-tool', { PATH: '.:bin::' }), null);
  const good = tempDir(t, 'zn-bare-good-');
  fs.writeFileSync(path.join(good, 'zn-bare-tool'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(exe.findProgram('zn-bare-tool', { PATH: '.:' + good }), path.join(good, 'zn-bare-tool'));
  assert.equal(exe.findProgram('./zn-bare-tool'), './zn-bare-tool', 'a name with a path is used as written');
  const env = exe.programEnv({ Path: '.:' + good, OTHER: '1' });
  assert.deepEqual(env, { OTHER: '1', PATH: good });
  assert.ok(work);
});

test('git status inside a hook never runs a git from the project folder or a relative PATH entry', posix, (t) => {
  const realGit = exe.findProgram('git');
  if (!realGit) { t.skip('git is not installed'); return; }
  const { work, marker } = planted(t, 'git');
  const script = 'process.chdir(' + JSON.stringify(work) + '); console.log(require(' + JSON.stringify(path.join(LIB, 'broker', 'files.js')) + ').gitStatusOf(' + JSON.stringify(path.join(work, 'a.txt')) + '))';
  for (const PATH of ['.:' + path.dirname(realGit), 'bin:' + path.dirname(realGit), ':' + path.dirname(realGit)]) {
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { PATH, HOME: work } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(marker), false, PATH + ': the planted git ran');
    assert.equal(r.stdout.trim(), 'outside', PATH);
  }
  // No git on an absolute entry: unknown, and still nothing planted runs.
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { PATH: '.:bin', HOME: work } });
  assert.equal(r.stdout.trim(), 'unknown');
  assert.equal(fs.existsSync(marker), false);
});

test('zn-gate shield starts a wrapped server named without a path from the absolute PATH entries only', posix, (t) => {
  const { work, marker } = planted(t, 'zn-bare-mcp');
  const script = 'require(' + JSON.stringify(path.join(LIB, 'shield.js')) + ').startMcpShield("zn-bare-mcp", [], { localOnly: true })';
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: work, input: '', timeout: 15000, env: { PATH: '.:bin:' + path.dirname(process.execPath), HOME: work } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /could not start 'zn-bare-mcp': it is not installed or not on your PATH/);
  assert.equal(fs.existsSync(marker), false, 'the planted server ran');
});

test('programEnv for Windows keeps drive and UNC entries and turns off the current-folder search', () => {
  const env = exe.programEnv({ Path: '.;C:\\Program Files\\nodejs;bin;;\\\\srv\\tools;C:rel', OTHER: '1' }, 'win32');
  assert.deepEqual(env, { OTHER: '1', PATH: 'C:\\Program Files\\nodejs;\\\\srv\\tools', NoDefaultCurrentDirectoryInExePath: '1' });
});

test('zn-gate shield gives the server the absolute PATH: `sh -c <name>` cannot start a program from the project', posix, (t) => {
  const { work, marker } = planted(t, 'zn-bare-mcp');
  const sh = exe.findProgram('sh');
  const script = 'require(' + JSON.stringify(path.join(LIB, 'shield.js')) + ').startMcpShield(' + JSON.stringify(sh) + ', ["-c", "zn-bare-mcp"], { localOnly: true })';
  for (const PATH of ['.:' + path.dirname(sh), 'bin:' + path.dirname(sh), ':' + path.dirname(sh)]) {
    spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: work, input: '', timeout: 15000, env: { PATH, HOME: work } });
    assert.equal(fs.existsSync(marker), false, PATH + ': the planted server ran through sh -c');
  }
});

test('git status: a failure other than "not a git repository" is unknown, and fsmonitor is off', posix, (t) => {
  const bin = tempDir(t, 'zn-bare-git-');
  const log = path.join(bin, 'args');
  const fake = (stderr) => fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho "$@" >> ' + JSON.stringify(log) + '\necho ' + JSON.stringify(stderr) + ' >&2\nexit 128\n', { mode: 0o755 });
  const script = 'console.log(require(' + JSON.stringify(path.join(LIB, 'broker', 'files.js')) + ').gitStatusOf(' + JSON.stringify(path.join(bin, 'a.txt')) + '))';
  const run = () => spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { PATH: bin + ':/usr/bin:/bin' } }).stdout.trim();
  fake("fatal: detected dubious ownership in repository at '/x'");
  assert.equal(run(), 'unknown');
  fake('fatal: not a git repository (or any of the parent directories): .git');
  assert.equal(run(), 'outside');
  assert.match(fs.readFileSync(log, 'utf8'), /^-c core\.fsmonitor=false -C /m);
});
