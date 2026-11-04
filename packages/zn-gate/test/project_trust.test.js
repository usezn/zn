'use strict';

// The --project hook command (launcher.js projectShCommand): its guard (PROJECT_TRUST) starts zn only when zn and node
// were found in absolute PATH entries. The generated script runs here under dash and under bash --posix, with fake
// programs that only leave a marker.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { projectShCommand } = require('../lib/agents/launcher');
const { tempDir } = require('./helpers/tmp');

const SHELLS = [['dash', '/bin/dash', []], ['bash --posix', '/bin/bash', ['--posix']]].filter(([, f]) => fs.existsSync(f));
const POSIX = process.platform !== 'win32' && SHELLS.length > 0;

// The command is `sh -c '<script>'`: the same script, run by the shell under test instead of `sh`.
function runGuard(shell, extra, cwd, PATH) {
  const cmd = projectShCommand('claude-code', 'PreToolUse');
  assert.ok(cmd.startsWith('sh -c '), cmd.slice(0, 20));
  const quoted = cmd.slice('sh -c '.length);
  return spawnSync(shell, [...extra, '-c', 'exec ' + shell + ' ' + extra.join(' ') + ' -c ' + quoted], {
    cwd, env: { PATH, HOME: '/nonexistent' }, input: '{}', encoding: 'utf8', timeout: 20000,
  });
}

function fakeZn(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'zn'), '#!/bin/sh\necho "zn $*" >> ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
  try { fs.symlinkSync(process.execPath, path.join(dir, 'node')); } catch (_) { /* already there */ }
  return dir;
}

function setup(t) {
  const proj = tempDir(t, 'zn-ptrust-proj-');
  fs.mkdirSync(path.join(proj, '.git'));
  const marker = path.join(tempDir(t, 'zn-ptrust-mark-'), 'ran.txt');
  return { proj, marker };
}

test('project hook guard: zn and node from an absolute PATH entry outside the project run (dash, bash --posix)', { skip: !POSIX }, (t) => {
  for (const [label, shell, extra] of SHELLS) {
    const { proj, marker } = setup(t);
    const bin = fakeZn(tempDir(t, 'zn-ptrust-bin-'), marker);
    const r = runGuard(shell, extra, proj, bin + ':/usr/bin:/bin');
    assert.equal(r.status, 0, label + ': ' + r.stderr);
    assert.match(fs.readFileSync(marker, 'utf8'), /^zn hook claude-code/, label);
  }
});

test('project hook guard: zn found through a relative PATH entry (the project folder) is not started (dash, bash --posix)', { skip: !POSIX }, (t) => {
  for (const [label, shell, extra] of SHELLS) {
    const { proj, marker } = setup(t);
    fakeZn(path.join(proj, 'bin'), marker);
    const r = runGuard(shell, extra, proj, 'bin:/usr/bin:/bin');
    assert.equal(fs.existsSync(marker), false, label + ': the project zn ran');
    assert.ok(r.status !== 0 || /zn/.test(r.stdout + r.stderr), label + ': the guard gave no answer');
  }
});

// The rule of the plugins' zn-node.sh: an entry whose real path is in the project, its git work tree or node_modules is skipped.
test('project hook guard: zn and node from an absolute PATH entry inside the project are not started (dash, bash --posix)', { skip: !POSIX }, (t) => {
  for (const [label, shell, extra] of SHELLS) {
    const { proj, marker } = setup(t);
    const bin = fakeZn(path.join(proj, 'bin'), marker);
    runGuard(shell, extra, proj, bin + ':/usr/bin:/bin');
    assert.equal(fs.existsSync(marker), false, label + ': the project zn ran');
  }
});

test('project hook guard: a project bin reached through a link, node_modules/.bin and a sub-folder of the git work tree are not started', { skip: !POSIX }, (t) => {
  for (const [label, shell, extra] of SHELLS) {
    const { proj, marker } = setup(t);
    const inside = fakeZn(path.join(proj, 'tools', 'bin'), marker);
    // A folder outside the project that links to the project's bin.
    const link = path.join(tempDir(t, 'zn-ptrust-link-'), 'bin');
    fs.symlinkSync(inside, link);
    const sub = path.join(proj, 'pkg');
    fs.mkdirSync(sub);
    const mods = fakeZn(path.join(tempDir(t, 'zn-ptrust-nm-'), 'node_modules', '.bin'), marker);
    for (const [where, dir, cwd] of [['link', link, proj], ['node_modules', mods, proj], ['sub-folder', inside, sub]]) {
      runGuard(shell, extra, cwd, dir + ':/usr/bin:/bin');
      assert.equal(fs.existsSync(marker), false, label + ' ' + where + ': the project zn ran');
    }
  }
});

test('project hook guard: a zn outside the project that links into the project is not started', { skip: !POSIX }, (t) => {
  for (const [label, shell, extra] of SHELLS) {
    const { proj, marker } = setup(t);
    const inside = fakeZn(path.join(proj, 'bin'), marker);
    const bin = tempDir(t, 'zn-ptrust-out-');
    fs.symlinkSync(path.join(inside, 'zn'), path.join(bin, 'zn'));
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    runGuard(shell, extra, proj, bin + ':/usr/bin:/bin');
    assert.equal(fs.existsSync(marker), false, label + ': the zn linked into the project ran');
  }
});

test('project hook guard: CLAUDE_PROJECT_DIR counts as the project even when the hook runs elsewhere', { skip: !POSIX }, (t) => {
  for (const [label, shell, extra] of SHELLS) {
    const { proj, marker } = setup(t);
    const bin = fakeZn(path.join(proj, 'bin'), marker);
    const elsewhere = tempDir(t, 'zn-ptrust-else-');
    const cmd = projectShCommand('claude-code', 'PreToolUse').slice('sh -c '.length);
    spawnSync(shell, [...extra, '-c', 'exec ' + shell + ' ' + extra.join(' ') + ' -c ' + cmd], {
      cwd: elsewhere, env: { PATH: bin + ':/usr/bin:/bin', HOME: elsewhere, CLAUDE_PROJECT_DIR: proj }, input: '{}', encoding: 'utf8', timeout: 20000,
    });
    assert.equal(fs.existsSync(marker), false, label + ': the project zn ran');
  }
});

test('project hook guard: the zn of a global npm install (bin/zn links into lib/node_modules/zn-gate) runs (dash, bash --posix)', { skip: !POSIX }, (t) => {
  for (const [label, shell, extra] of SHELLS) {
    const { proj, marker } = setup(t);
    const prefix = tempDir(t, 'zn-ptrust-npmg-');
    const pkgBin = path.join(prefix, 'lib', 'node_modules', 'zn-gate', 'bin');
    fs.mkdirSync(pkgBin, { recursive: true });
    fs.writeFileSync(path.join(pkgBin, 'cli.js'), '#!/bin/sh\necho "zn $*" >> ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
    fs.mkdirSync(path.join(prefix, 'bin'));
    fs.symlinkSync('../lib/node_modules/zn-gate/bin/cli.js', path.join(prefix, 'bin', 'zn'));
    fs.symlinkSync(process.execPath, path.join(prefix, 'bin', 'node'));
    const r = runGuard(shell, extra, proj, path.join(prefix, 'bin') + ':/usr/bin:/bin');
    assert.equal(r.status, 0, label + ': ' + r.stdout + r.stderr);
    assert.match(fs.readFileSync(marker, 'utf8'), /^zn hook claude-code/, label);
  }
});

test('project hook guard: a folder above the home folder named as the project does not refuse the home folder', { skip: !POSIX }, (t) => {
  for (const [label, shell, extra] of SHELLS) {
    const { proj, marker } = setup(t);
    const root = tempDir(t, 'zn-ptrust-above-');
    const home = path.join(root, 'home');
    const bin = fakeZn(path.join(home, '.local', 'bin'), marker);
    const cmd = projectShCommand('claude-code', 'PreToolUse').slice('sh -c '.length);
    const r = spawnSync(shell, [...extra, '-c', 'exec ' + shell + ' ' + extra.join(' ') + ' -c ' + cmd], {
      cwd: proj, env: { PATH: bin + ':/usr/bin:/bin', HOME: home, CLAUDE_PROJECT_DIR: root }, input: '{}', encoding: 'utf8', timeout: 20000,
    });
    assert.equal(r.status, 0, label + ': ' + r.stdout + r.stderr);
    assert.ok(fs.existsSync(marker), label + ': the zn in the home folder did not run');
  }
});

test('project hook guard: with the hook folder deleted it ends at once and blocks (dash, bash --posix)', { skip: !POSIX }, (t) => {
  for (const [label, shell, extra] of SHELLS) {
    const { marker } = setup(t);
    const bin = fakeZn(tempDir(t, 'zn-ptrust-gone-bin-'), marker);
    const gone = path.join(tempDir(t, 'zn-ptrust-gone-'), 'work');
    fs.mkdirSync(gone);
    const quoted = projectShCommand('claude-code', 'PreToolUse').slice('sh -c '.length);
    const q = (x) => "'" + x.replace(/'/g, "'\\''") + "'";
    // cd into the folder, delete it, then start the guard from there: the shell is left in a folder that no longer exists.
    const r = spawnSync('/bin/sh', ['-c', 'cd ' + q(gone) + ' && rmdir ' + q(gone) + ' && exec ' + shell + ' ' + extra.join(' ') + ' -c ' + quoted], {
      env: { PATH: bin + ':/usr/bin:/bin', HOME: '/nonexistent' }, input: '{}', encoding: 'utf8', timeout: 10000,
    });
    assert.equal(r.signal, null, label + ': the guard did not end (killed by the timeout)');
    assert.equal(r.status, 2, label + ': ' + r.stdout + r.stderr);
    assert.equal(fs.existsSync(marker), false, label + ': zn ran without the hook folder');
  }
});

test('project hook guard: a node that links into a node_modules folder outside the project is refused, as the plugin does', { skip: !POSIX }, (t) => {
  for (const [label, shell, extra] of SHELLS) {
    const { proj, marker } = setup(t);
    const prefix = tempDir(t, 'zn-ptrust-nodenm-');
    fs.mkdirSync(path.join(prefix, 'bin'));
    fs.writeFileSync(path.join(prefix, 'bin', 'zn'), '#!/bin/sh\necho "zn $*" >> ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
    const nm = path.join(prefix, 'lib', 'node_modules', 'node', 'bin');
    fs.mkdirSync(nm, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(nm, 'node'));
    fs.symlinkSync('../lib/node_modules/node/bin/node', path.join(prefix, 'bin', 'node'));
    const r = runGuard(shell, extra, proj, path.join(prefix, 'bin') + ':/usr/bin:/bin');
    assert.equal(fs.existsSync(marker), false, label + ': zn ran with a node from node_modules');
    assert.notEqual(r.status, 0, label);
  }
});
