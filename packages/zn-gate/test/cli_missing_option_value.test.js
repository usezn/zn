'use strict';

// An option that takes a value, given as the last argument with nothing after it, is a usage error (exit 2),
// not an option that is silently ignored (docs/cli.md: exit 2 for "a missing value").

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function cli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ZN_STATS: 'off', ZN_LOCAL_ONLY: 'true' } });
}

test('scan with a value option and no value exits 2 and names the option', (t) => {
  const dir = tempDir(t, 'zn-missing-value-');
  for (const opt of ['--format', '--include', '--exclude', '--key', '--stage', '--url']) {
    for (const args of [['scan', opt], ['scan', dir, opt]]) {
      const r = cli(args, dir);
      assert.equal(r.status, 2, args.join(' ') + ' -> ' + r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp('zn-gate: ' + opt + ' needs a value'), args.join(' '));
    }
  }
});

test('analyze with a value option and no value exits 2', (t) => {
  const dir = tempDir(t, 'zn-missing-value-');
  for (const opt of ['--key', '--stage', '--url']) {
    const r = cli(['analyze', 'hello', opt], dir);
    assert.equal(r.status, 2, opt);
    assert.match(r.stderr, new RegExp(opt + ' needs a value'));
  }
});

test('status and evidence with a value option and no value exit 2', (t) => {
  const dir = tempDir(t, 'zn-missing-value-');
  for (const [cmd, opt] of [['status', '--key'], ['status', '--url'], ['evidence', '--format'], ['evidence', '--output'], ['evidence', '--port'], ['evidence', '--tail']]) {
    const r = cli([cmd, opt], dir);
    assert.equal(r.status, 2, cmd + ' ' + opt);
    assert.match(r.stderr, new RegExp(opt + ' needs a value'), cmd + ' ' + opt);
  }
});

test('a value that is given still works, with a space or with =', (t) => {
  const dir = tempDir(t, 'zn-missing-value-');
  require('fs').writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  for (const args of [['scan', dir, '--format', 'json'], ['scan', dir, '--format=json'], ['scan', dir, '--include', '.rst']]) {
    const r = cli(args, dir);
    assert.notEqual(r.status, 2, args.join(' ') + ' -> ' + r.stderr);
  }
});

test('evidence --port and --tail need a whole number and exit 2 otherwise', (t) => {
  const dir = tempDir(t, 'zn-missing-value-');
  for (const [opt, bad] of [['--tail', 'abc'], ['--tail', '0'], ['--tail', '-5'], ['--tail', '2.5'], ['--port', 'abc'], ['--port', '0'], ['--port', '70000'], ['--port', '80x']]) {
    const r = cli(['evidence', opt, bad], dir);
    assert.equal(r.status, 2, opt + ' ' + bad + ' -> ' + r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(opt + ' needs a whole number'), opt + ' ' + bad);
  }
  for (const args of [['evidence', '--tail', '5'], ['evidence', '--tail', '5', '--export']]) {
    const r = cli(args, dir);
    assert.notEqual(r.status, 2, args.join(' ') + ' -> ' + r.stderr);
  }
});
