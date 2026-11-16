'use strict';
// The help of zn-gate lists the options and commands the CLI really takes.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input: '',
    env: Object.assign({}, process.env, { NO_COLOR: '1', ZN_STATS: 'off', ZN_LOCAL_ONLY: 'true' }),
  });
}

test('zn-gate --help lists the vault, connect, unlock, hooks, run, team and env options', () => {
  const r = run(['--help']);
  assert.strictEqual(r.status, 0, r.stderr);
  for (const s of [
    'vault reset', 'vault purge', 'vault team',
    '--acknowledge',
    '[--backend NAME]',
    '--reconnect',
    '[--project] [--no-mcp]',
    '-s is a short form of --secrets', '--agent ID',
    '--include-history', '--api URL',
    'env unshadow FILE --backup NAME',
  ]) {
    assert.ok(r.stdout.includes(s), 'the help should mention: ' + s);
  }
});

test('zn-gate vault --help lists reset, purge, team and verify --acknowledge', () => {
  const r = run(['vault', '--help']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /verify \[--acknowledge\]/);
  assert.match(r.stdout, /reset\s+lost the passphrase/);
  assert.match(r.stdout, /purge \[--yes\]/);
  assert.match(r.stdout, /team\s+shows that a shared team vault is planned/);
});
