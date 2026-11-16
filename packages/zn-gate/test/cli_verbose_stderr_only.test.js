'use strict';
// `status` with ZN_VERBOSE=1 or --verbose: stdout is the same as without them.
// Any extra debug text may only go to stderr. Runs in a temporary home with
// invented values.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function run(args, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-verbose-'));
  try {
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      ZN_LOCAL_ONLY: 'true',
      NO_COLOR: '1',
      ZN_KEYCHAIN_BACKEND: 'passphrase',
      ...extraEnv,
    };
    return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: home });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('status: ZN_VERBOSE=1 leaves stdout and the exit status unchanged', () => {
  const plain = run(['status']);
  const verbose = run(['status'], { ZN_VERBOSE: '1' });
  assert.strictEqual(plain.status, 0, plain.stderr);
  assert.strictEqual(verbose.status, plain.status, verbose.stderr);
  assert.match(plain.stdout, /zn-gate Status:/);
  assert.strictEqual(verbose.stdout, plain.stdout);
});

test('status: --verbose leaves stdout and the exit status unchanged', () => {
  const plain = run(['status']);
  const verbose = run(['status', '--verbose']);
  assert.strictEqual(verbose.status, plain.status, verbose.stderr);
  assert.strictEqual(verbose.stdout, plain.stdout);
});

test('status: the run without verbose prints nothing on stderr', () => {
  assert.strictEqual(run(['status']).stderr, '');
});

test('status: debug text never reaches stdout', () => {
  for (const r of [run(['status'], { ZN_VERBOSE: '1' }), run(['status', '--verbose'])]) {
    assert.doesNotMatch(r.stdout, /\bdebug\b|\[zn-gate\]|Warning:|Error:/i);
  }
});
