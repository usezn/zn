'use strict';
// Every flag that docs/cli.md documents for these commands appears in the help of that command
// and in the general help (`zn-gate --help`), so users can find it without reading the docs.
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

// [subcommand arguments, flags documented in docs/cli.md for that subcommand]
const CASES = [
  [['audit'], ['--approve', '--include-home', '--fail-on']],
  [['unlock'], ['--foreground', '--ttl', '--idle']],
  [['secret', 'set'], ['--force', '--in', '--clipboard', '--mode', '--host', '--command']],
  [['secret', 'allow'], ['--in', '--replace', '--host', '--command', '--mode']],
  [['secret', 'import'], ['--all', '--keys', '--force', '--host', '--command']],
  [['secret', 'adopt'], ['--name', '--host', '--command']],
  [['env', 'shadow'], ['--all', '--keys', '--force', '--dry-run', '--host', '--command']],
];

for (const [sub, flags] of CASES) {
  const name = sub.join(' ');
  test('zn-gate ' + name + ' --help lists its documented flags', () => {
    const r = run([...sub, '--help']);
    assert.strictEqual(r.status, 0, r.stderr);
    for (const f of flags) assert.ok(r.stdout.includes(f), name + ' --help should mention ' + f);
  });
  test('zn-gate --help lists the documented flags of ' + name, () => {
    const r = run(['--help']);
    assert.strictEqual(r.status, 0, r.stderr);
    for (const f of flags) assert.ok(r.stdout.includes(f), 'zn-gate --help should mention ' + name + ' ' + f);
  });
}
