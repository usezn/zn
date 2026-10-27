'use strict';

// Programs zn starts by name never come from the project: an absolute PATH entry into the folder zn runs in, its git
// work tree, the agent's project or node_modules is skipped, and so is a program that links there. Fake programs only
// leave a marker; none of them may run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const exe = require('../lib/exe');
const { tempDir } = require('./helpers/tmp');

const POSIX = process.platform !== 'win32';
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const real = (p) => fs.realpathSync(p);

function project(t) {
  const home = tempDir(t, 'zn-trust-home-');
  const proj = tempDir(t, 'zn-trust-proj-');
  fs.mkdirSync(path.join(proj, '.git'));
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  const marker = path.join(tempDir(t, 'zn-trust-mark-'), 'ran.txt');
  return { home, proj, marker };
}

function fakeProgram(dir, name, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), '#!/bin/sh\necho "' + name + ' $*" >> ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
  return dir;
}

test('trustedPath drops entries in the project, its work tree, CLAUDE_PROJECT_DIR and node_modules, and keeps the home folder', { skip: !POSIX }, (t) => {
  const { home, proj } = project(t);
  const other = tempDir(t, 'zn-trust-agentproj-');
  const nm = path.join(tempDir(t, 'zn-trust-nm-'), 'node_modules', '.bin');
  fs.mkdirSync(nm, { recursive: true });
  const homeBin = path.join(home, '.local', 'bin');
  fs.mkdirSync(homeBin, { recursive: true });
  const link = path.join(tempDir(t, 'zn-trust-link-'), 'bin');
  fs.symlinkSync(path.join(proj, 'src'), link);
  const PATH = [path.join(proj, 'bin'), path.join(proj, 'src'), link, nm, path.join(other, 'bin'), homeBin, '/usr/bin', 'rel', ''].join(':');
  const kept = exe.trustedPath(PATH, path.join(proj, 'src'), { HOME: home, CLAUDE_PROJECT_DIR: other }).split(':');
  assert.deepEqual(kept, [homeBin, '/usr/bin']);
  // From the home folder itself (or a dotfiles home with git), entries under it stay.
  fs.mkdirSync(path.join(home, '.git'));
  assert.deepEqual(exe.trustedPath([homeBin, '/usr/bin'].join(':'), home, { HOME: home }).split(':'), [homeBin, '/usr/bin']);
});

test('findProgram skips a program in the project bin/ and one that links into the project', { skip: !POSIX }, (t) => {
  const { home, proj, marker } = project(t);
  const projBin = fakeProgram(path.join(proj, 'bin'), 'git', marker);
  const linkDir = tempDir(t, 'zn-trust-linkdir-');
  fs.symlinkSync(path.join(projBin, 'git'), path.join(linkDir, 'git'));
  const env = { HOME: home, PATH: [projBin, linkDir, '/usr/bin', '/bin'].join(':') };
  const found = exe.findProgram('git', env, path.join(proj, 'src'));
  assert.ok(found === null || !real(found).startsWith(real(proj)), String(found));
  assert.ok(found === null || !found.startsWith(linkDir), String(found));
  assert.equal(exe.findProgram('git', { HOME: home, PATH: [projBin, linkDir].join(':') }, proj), null);
  assert.equal(fs.existsSync(marker), false);
});

test('a hook checking git status never starts the project git (gitStatusOf from the project folder)', { skip: !POSIX }, (t) => {
  const { home, proj, marker } = project(t);
  const projBin = fakeProgram(path.join(proj, 'bin'), 'git', marker);
  fs.writeFileSync(path.join(proj, 'src', 'a.txt'), 'x');
  const code = 'process.stdout.write(require(' + JSON.stringify(path.join(__dirname, '..', 'lib', 'broker', 'files.js')) + ').gitStatusOf(' + JSON.stringify(path.join(proj, 'src', 'a.txt')) + '))';
  const r = spawnSync(process.execPath, ['-e', code], {
    cwd: path.join(proj, 'src'),
    env: { HOME: home, PATH: [projBin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':') },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(marker), false, 'gitStatusOf started the git of the project');
});

test('zn-gate shield never starts an MCP server program from the project bin/', { skip: !POSIX }, (t) => {
  const { home, proj, marker } = project(t);
  const projBin = fakeProgram(path.join(proj, 'bin'), 'zn-fake-mcp-server', marker);
  const r = spawnSync(process.execPath, [CLI, 'shield', '--', 'zn-fake-mcp-server'], {
    cwd: proj,
    env: { HOME: home, PATH: [projBin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':') },
    input: '',
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.notEqual(r.status, 0, 'shield found the server in the project');
  assert.equal(fs.existsSync(marker), false, 'shield started the server of the project');
});
