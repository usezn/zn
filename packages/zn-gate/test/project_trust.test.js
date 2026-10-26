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
    cwd, env: { PATH, HOME: cwd }, input: '{}', encoding: 'utf8', timeout: 20000,
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

// The guard trusts any absolute PATH entry today; the rule of the plugins' zn-node.sh (skip entries whose real path is in
// the project, its git work tree or node_modules) is still to be ported into it. Kept as todo until then.
test('project hook guard: zn and node from an absolute PATH entry inside the project are not started (dash, bash --posix)', { skip: !POSIX, todo: 'port the zn-node.sh folder rule into PROJECT_TRUST' }, (t) => {
  for (const [label, shell, extra] of SHELLS) {
    const { proj, marker } = setup(t);
    const bin = fakeZn(path.join(proj, 'bin'), marker);
    runGuard(shell, extra, proj, bin + ':/usr/bin:/bin');
    assert.equal(fs.existsSync(marker), false, label + ': the project zn ran');
  }
});
