'use strict';
/* Every subcommand answers --help with its own usage and exit code 0, and the general help is complete. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { listAdapters } = require('../lib/agents');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
function zn(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ZN_STATS: 'off' } });
}

// [arguments before --help, text the first usage line must hold]
const CASES = [
  [['vault'], 'zn vault status'],
  [['vault', 'status'], 'zn vault status'],
  [['vault', 'reset'], 'zn vault status'],
  [['vault', 'team'], 'zn vault status'],
  [['vault', 'log', 'export'], 'zn vault log export --otlp'],
  [['team'], 'zn team join'],
  [['team', 'status'], 'zn team join'],
  [['hooks'], 'zn hooks install'],
  [['secret'], 'zn secret set'],
  [['unlock'], 'zn unlock'],
  [['lock'], 'zn lock'],
  [['env'], 'zn env shadow'],
  [['env', 'shadow'], 'zn env shadow'],
  [['scan'], 'zn scan [folder]'],
  [['reach'], 'zn reach'],
  [['audit'], 'zn audit'],
  [['evidence'], 'zn evidence'],
];

for (const [words, usage] of CASES) {
  test('zn ' + words.join(' ') + ' --help prints its own usage and exits 0', () => {
    const r = zn([...words, '--help']);
    assert.equal(r.status, 0, r.stderr);
    const first = r.stdout.split('\n').find((l) => l.trim());
    assert.match(first, /^usage: /, 'not the general help: ' + first);
    assert.ok(first.includes(usage), first + ' should hold ' + usage);
  });
}

test('the vault help lists every vault subcommand', () => {
  const out = zn(['vault', '--help']).stdout;
  for (const sub of ['status', 'log', 'verify', 'forget', 'reset', 'team', 'log export']) {
    assert.ok(out.includes(sub), 'vault --help misses ' + sub);
  }
});

test('vault log export without --otlp is still a usage error (exit 2)', () => {
  const r = zn(['vault', 'log', 'export']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: zn vault log export --otlp/);
});

test('the general help lists every agent of hooks install and scan [path] as optional', () => {
  const out = zn(['--help']).stdout;
  const line = out.split('\n').find((l) => l.includes('Install zn')) || '';
  for (const id of listAdapters()) assert.ok(line.includes(id), 'general help misses agent ' + id + ': ' + line);
  assert.match(out, /^\s+scan \[path\]\s/m);
  assert.doesNotMatch(out, /scan <path>/);
  assert.match(out, /vault reset/);
  assert.match(out, /vault team/);
});
