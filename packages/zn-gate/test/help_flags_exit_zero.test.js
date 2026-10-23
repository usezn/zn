'use strict';

// --help and -h print the usage and exit 0, also right after an option that takes a value.
// Every run uses a temporary home; nothing touches the real one.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function zn(t, args) {
  const home = tempDir(t, 'zn-help-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), CODEX_HOME: path.join(home, '.codex'), ZN_STATS: 'off' };
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: home, input: '' });
}

const CASES = [
  [['env', 'shadow', '--help'], /^usage: zn env shadow/],
  [['env', 'shadow', '-h'], /^usage: zn env shadow/],
  [['env', 'shadow', '--keys', '--help'], /^usage: zn env shadow/],
  [['env', 'shadow', '--mode', '--help'], /^usage: zn env shadow/],
  [['env', 'shadow', '--host', '--help'], /^usage: zn env shadow/],
  [['env', 'unshadow', '--help'], /^usage: zn env/],
  [['unlock', '--help'], /^usage: zn unlock/],
  [['unlock', '--ttl', '--help'], /^usage: zn unlock/],
  [['unlock', '--idle', '-h'], /^usage: zn unlock/],
  [['lock', '--help'], /^usage: zn lock/],
  [['vault', '--help'], /^usage: zn vault/],
  [['vault', 'log', '--since', '--help'], /^usage: zn vault/],
  [['secret', 'allow', '--host', '--help'], /^usage: zn secret/],
  [['secret', 'import', '--help'], /^usage: zn secret/],
  [['audit', '--help'], /^usage: zn audit/],
  [['audit', '--agents', '--help'], /^usage: zn audit/],
  [['audit', '--format', '-h'], /^usage: zn audit/],
  [['audit', '--fail-on', '--help'], /^usage: zn audit/],
];

for (const [args, re] of CASES) {
  test('zn ' + args.join(' ') + ' prints the usage and exits 0', (t) => {
    const r = zn(t, args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, re);
    assert.doesNotMatch(r.stdout + r.stderr, /needs a value/);
  });
}
