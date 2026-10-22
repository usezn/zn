'use strict';
// zn-gate piped into a reader that closes early (for example `zn-gate check | head -1`): no stack trace, and the
// same exit status as a run whose output is read to the end.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

// Runs `zn-gate check` with an empty home. When `closeEarly` is set, the reading end of stdout is closed before the
// child writes anything, so every write fails with EPIPE.
function runCli(t, { closeEarly, args = ['check'] }) {
  const home = tempDir(t, 'zn-epipe-home-');
  const cwd = tempDir(t, 'zn-epipe-cwd-');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { HOME: home, PATH: process.env.PATH, ZN_STATS: 'off', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    if (closeEarly) child.stdout.destroy();
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

test('check: a reader that closes stdout early gets no EPIPE error or stack trace', async (t) => {
  const normal = await runCli(t, { closeEarly: false });
  const closed = await runCli(t, { closeEarly: true });

  assert.equal(closed.signal, null);
  assert.doesNotMatch(closed.stderr, /EPIPE/);
  assert.doesNotMatch(closed.stderr, /^\s+at /m);
  assert.equal(closed.code, normal.code, 'same exit status as a run whose output is read');
});

test('--help: a run that succeeds still exits 0 when the reader closes stdout early', async (t) => {
  const closed = await runCli(t, { closeEarly: true, args: ['--help'] });

  assert.equal(closed.signal, null);
  assert.doesNotMatch(closed.stderr, /EPIPE/);
  assert.equal(closed.code, 0, 'EPIPE never turns a successful run into a failure');
});
