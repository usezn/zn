'use strict';
// Commands that take no options or a fixed set refuse an option they do not know: exit 2, the option named, the
// options the command takes listed. The accepted options keep working, and -h, --help, -V and --version still pass.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

function run(args, home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: home, NO_COLOR: '1' };
  delete env.ZN_STATS;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: '', cwd: home, env, timeout: 60000 });
}

function refused(args, option, listed) {
  return (t) => {
    const home = tempDir(t, 'zn-fixed-flag-');
    const r = run(args, home);
    assert.strictEqual(r.status, 2, r.stderr);
    assert.match(r.stderr, new RegExp('^zn-gate: unknown option "' + option.replace(/[-]/g, '\\-') + '"\\. ', 'm'));
    assert.match(r.stderr, listed);
    assert.strictEqual(r.stdout, '');
    assert.doesNotMatch(r.stderr + r.stdout, /\n\s+at .*[(:]\d+:\d+\)?|TypeError|ReferenceError|node:internal/);
  };
}

for (const command of ['check', 'doctor']) {
  test(`${command} --bogus is refused with exit 2, names the flag and lists the options it takes`, refused([command, '--bogus'], '--bogus', /The options of zn-gate \S+ are --hooks, --json\./));
}

test('check refuses an unknown option that comes after --hooks', refused(['check', '--hooks', '--bogus'], '--bogus', /are --hooks, --json\./));

test('version refuses an unknown option and says it takes none', refused(['version', '--bogus'], '--bogus', /zn-gate version takes no options\./));
test('status refuses an unknown option and lists its options', refused(['status', '--bogus'], '--bogus', /The options of zn-gate status are --key, --stage, --url, --local-only, --verbose\./));
test('test refuses an unknown option and says it takes none', refused(['test', '--bogus'], '--bogus', /zn-gate test takes no options\./));
test('evidence refuses an unknown option and lists its options', refused(['evidence', '--bogus'], '--bogus', /The options of zn-gate evidence are --verify, --ui, --export, --format, --output, --port, --tail\./));
test('logs refuses an unknown option and lists its options', refused(['logs', '--bogus'], '--bogus', /The options of zn-gate logs are /));
test('team status refuses an unknown option and lists its options', refused(['team', 'status', '--bogus'], '--bogus', /The options of zn-gate team status are --json, --rules\./));

test('check --hooks is still accepted', (t) => {
  const home = tempDir(t, 'zn-fixed-flag-');
  const r = run(['check', '--hooks'], home);
  assert.notStrictEqual(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /unknown option/);
});

test('plain check is still accepted', (t) => {
  const home = tempDir(t, 'zn-fixed-flag-');
  const r = run(['check'], home);
  assert.ok(r.status === 0 || r.status === 1, 'exit code was ' + r.status + ': ' + r.stderr);
  assert.doesNotMatch(r.stderr, /unknown option/);
  assert.match(r.stdout, /zn-gate check/);
});

test('status accepts its global options', (t) => {
  const home = tempDir(t, 'zn-fixed-flag-');
  const r = run(['status', '--local-only', '--stage', 'v30', '--verbose'], home);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /unknown option/);
  assert.match(r.stdout, /zn-gate Status/);
});

test('version accepts -V and --version and still prints the version', (t) => {
  const home = tempDir(t, 'zn-fixed-flag-');
  for (const args of [['version'], ['version', '-V'], ['version', '--version']]) {
    const r = run(args, home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^zn-gate \d+\.\d+\.\d+/);
  }
});

test('logs accepts its --tail option', (t) => {
  const home = tempDir(t, 'zn-fixed-flag-');
  const r = run(['logs', '--tail', '5'], home);
  assert.notStrictEqual(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /unknown option/);
});

test('team status accepts --json', (t) => {
  const home = tempDir(t, 'zn-fixed-flag-');
  const r = run(['team', 'status', '--json'], home);
  assert.notStrictEqual(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /unknown option/);
});

test('check --help still prints the general help and exits 0', (t) => {
  const home = tempDir(t, 'zn-fixed-flag-');
  const r = run(['check', '--help'], home);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /USAGE/);
  assert.doesNotMatch(r.stderr, /unknown option/);
});

test('test --help still prints the general help and exits 0', (t) => {
  const home = tempDir(t, 'zn-fixed-flag-');
  const r = run(['test', '--help'], home);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /USAGE/);
});
