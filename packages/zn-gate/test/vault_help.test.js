'use strict';
/* `--help` on zn unlock, zn lock, zn vault and zn env shadow prints that command's own usage. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { helpFor } = require('../lib/vault/help');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

test('helpFor answers only the vault commands and env shadow', () => {
  assert.equal(helpFor(['unlock']), null);
  assert.match(helpFor(['unlock', '--help'])[0], /^usage: zn unlock /);
  assert.equal(helpFor(['lock', '-h'])[0], 'usage: zn lock');
  assert.match(helpFor(['vault', '--help'])[0], /^usage: zn vault /);
  assert.match(helpFor(['env', 'shadow', '--help'])[0], /^usage: zn env shadow /);
  assert.equal(helpFor(['vault', 'log', '--help']), null, 'the audit command answers its own help');
  assert.equal(helpFor(['env', '--help']), null);
  assert.equal(helpFor(['reach', '--help']), null);
});

test('the unlock help lists every flag of zn unlock', () => {
  const text = helpFor(['unlock', '--help']).join('\n');
  for (const flag of ['--ttl', '--idle', '--backend', '--passphrase-stdin', '--foreground']) {
    assert.match(text, new RegExp(flag));
  }
});

test('the env shadow help lists its flags', () => {
  const text = helpFor(['env', 'shadow', '--help']).join('\n');
  for (const flag of ['--all', '--keys', '--dry-run', '--force', '--mode', '--host', '--command']) {
    assert.match(text, new RegExp(flag));
  }
});

test('each vault command prints its own help through the CLI, not the general help', () => {
  const cases = [
    [['unlock', '--help'], 'usage: zn unlock '],
    [['lock', '--help'], 'usage: zn lock'],
    [['vault', '--help'], 'usage: zn vault '],
    [['env', 'shadow', '--help'], 'usage: zn env shadow '],
  ];
  for (const [args, usage] of cases) {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(r.status, 0, args.join(' ') + ' exited ' + r.status + ': ' + r.stderr);
    assert.equal(r.stdout.split('\n')[0].startsWith(usage), true, args.join(' ') + ' printed: ' + r.stdout.slice(0, 120));
    assert.doesNotMatch(r.stdout, /zn-gate v\d|^USAGE:/m, args.join(' ') + ' printed the general help');
  }
});
