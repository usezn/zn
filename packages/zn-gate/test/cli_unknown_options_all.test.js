'use strict';
// The commands with a fixed option list refuse an option they do not take: they name it, list the options of the
// command and exit 2 (64 for the secret and env commands and vault log, as docs/exit-codes.md says). Nothing goes to stdout.
// The options each command documents keep working.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG = path.resolve(__dirname, '..');
const CLI = path.resolve(PKG, 'bin', 'cli.js');
const { simpleOptionProblem } = require(path.join(PKG, 'lib', 'cli-args'));

let home;
test.before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-unknown-opts-'));
});
test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input: '',
    timeout: 60000,
    cwd: home,
    env: Object.assign({}, process.env, {
      NO_COLOR: '1',
      ZN_STATS: 'off',
      ZN_LOCAL_ONLY: 'true',
      HOME: home,
      USERPROFILE: home,
    }),
  });
}

const REJECTED = [
  // [arguments, exit code, the options the message must list]
  [['status', '--bogus'], 2, '--key, --stage, --url, --long-input, --local-only, --verbose'],
  [['test', '--json'], 2, '--key, --stage'], // Node test has no --json (the Python one does)
  [['test', '--bogus'], 2, '--key, --stage'],
  [['check', '--bogus'], 2, '--verbose'],
  [['doctor', '--bogus'], 2, '--verbose'],
  [['version', '--bogus'], 2, 'takes no options'],
  [['evidence', '--bogus'], 2, '--verify, --ui, --export'],
  [['logs', '--bogus'], 2, '--verify, --ui, --export'],
  [['export', '--bogus'], 2, '--verify, --ui, --export'],
  [['mcp', '--bogus'], 2, '--key, --stage'],
  [['shield', '--bogus', '--', 'echo'], 2, '--key, --stage'],
  [['secrets-mcp', '--bogus'], 2, '--agent'],
  [['report', '--bogus'], 2, '--since, --json, --no-team-line'],
  [['stats', '--bogus'], 2, '--days, --json'],
  [['pins', '--bogus'], 2, '--all'],
  [['team', 'status', '--bogus'], 2, '--json'],
  [['team', 'sync', '--bogus'], 2, 'takes no options'],
  [['team', 'leave', '--bogus'], 2, 'takes no options'],
  [['team', 'join', '--bogus'], 2, '--api, --agent, --include-history'],
  [['vault', 'log', '--bogus'], 64, '--since'],
  [['vault', 'log', 'export', '--bogus'], 2, '--otlp, --since, --out, --unverified'],
  [['secret', 'list', '--bogus'], 64, 'takes no options'],
  [['secret', 'set', 'FAKE_NAME', '--bogus'], 64, '--mode, --in, --host, --command, --type, --force, --clipboard'],
  [['secrets', 'allow', 'FAKE_NAME', '--bogus'], 64, '--host, --in, --replace, --mode, --command'],
  [['secret', 'approve', 'FAKE_NAME', '--bogus'], 64, '--command'],
  [['secret', 'import', '--bogus'], 64, '--all, --keys'],
  [['secret', 'adopt', 'AWS_KEY_1', '--bogus'], 64, '--name, --host'],
  [['secret', 'log', '--bogus'], 64, '--since'],
  [['env', 'shadow', '--bogus'], 64, '--all, --keys, --host, --command, --force, --dry-run'],
  [['env', 'unshadow', '.env', '--bogus'], 64, '--backup'],
];

for (const [args, code, listed] of REJECTED) {
  test(`zn-gate ${args.join(' ')} refuses the unknown option with exit ${code}`, () => {
    const r = run(args);
    assert.strictEqual(r.status, code, r.stderr);
    const opt = args.slice(1).find((a) => a.startsWith('--') && a !== '--');
    assert.ok(r.stderr.includes('unknown option "' + opt + '"'), r.stderr);
    assert.ok(r.stderr.includes(listed), r.stderr);
    assert.strictEqual(r.stdout, '');
  });
}

const ACCEPTED = [
  // documented options and their values: never refused as unknown, never a usage error
  ['status', '--local-only'],
  ['status', '--stage', 'v30'],
  ['status', '--stage=v30'],
  ['evidence', '--verify'],
  ['evidence', '--tail', '5'],
  ['logs', '--tail', '5'],
  ['export', '--format', 'csv'],
  ['report', '--since', '7d', '--json'],
  ['stats', '--days', '7', '--json'],
  ['pins'],
  ['pins', 'list'],
  ['team', 'status', '--json'],
  ['secret', 'list'],
  ['check', '--verbose'],
];

for (const args of ACCEPTED) {
  test(`zn-gate ${args.join(' ')} still accepts its documented options`, () => {
    const r = run(args);
    assert.doesNotMatch(r.stderr, /unknown option/, r.stderr);
    assert.notStrictEqual(r.status, 2, r.stderr);
    assert.notStrictEqual(r.status, 64, r.stderr);
  });
}

test('status --version and version --version still print the version', () => {
  for (const args of [['status', '--version'], ['version', '--version']]) {
    const r = run(args);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^zn-gate \d/);
  }
});

test('--help is accepted by every checked command', () => {
  const r = run(['evidence', '--help']);
  assert.doesNotMatch(r.stderr, /unknown option/);
  assert.strictEqual(r.status, 0, r.stderr);
});

test('a bare "--" ends the options: what follows is not checked', () => {
  assert.strictEqual(simpleOptionProblem(['status', '--', '--bogus']), null);
  assert.strictEqual(simpleOptionProblem(['shield', '--local-only', '--', 'echo', '--bogus']), null);
});

test('simpleOptionProblem names the option, lists the options and sets the exit code', () => {
  const p = simpleOptionProblem(['evidence', '--bogus']);
  assert.strictEqual(p.code, 2);
  assert.strictEqual(p.message, 'unknown option "--bogus". The options of zn-gate evidence are --verify, --ui, --export, --format, --output, --port, --tail.');
  assert.strictEqual(simpleOptionProblem(['secret', 'set', 'X', '--bogus']).code, 64);
  assert.strictEqual(simpleOptionProblem(['vault', 'log', 'export', '--bogus']).code, 2);
});

test('an unknown option is read by name, including the part after an equals sign', () => {
  assert.strictEqual(simpleOptionProblem(['status', '--format=json']).code, 2);
  assert.strictEqual(simpleOptionProblem(['status', '--local-only=yes']), null);
});

test('commands outside the list are not checked here', () => {
  assert.strictEqual(simpleOptionProblem(['scan', '--bogus']), null);
  assert.strictEqual(simpleOptionProblem(['hook', 'claude-code', '--bogus']), null);
  assert.strictEqual(simpleOptionProblem(['vault', 'unlock', '--bogus']), null);
  assert.strictEqual(simpleOptionProblem(['team', 'unknownsub', '--bogus']), null);
});

test('the global --verbose is accepted by every command with a fixed option list', () => {
  for (const args of [['evidence'], ['report'], ['stats'], ['pins'], ['version'], ['team', 'sync'], ['secret', 'list'], ['env', 'unshadow'], ['vault', 'log'], ['vault', 'log', 'export'], ['secrets-mcp']]) {
    const spec = simpleOptionProblem(args.concat(['--verbose']));
    assert.strictEqual(spec, null, args.join(' ') + ' --verbose must not be refused');
  }
});

test('vault log export refuses an unknown option with 2, like its own usage error; vault log keeps 64', () => {
  assert.strictEqual(simpleOptionProblem(['vault', 'log', 'export', '--bogus']).code, 2);
  assert.strictEqual(simpleOptionProblem(['vault', 'log', '--bogus']).code, 64);
  assert.strictEqual(simpleOptionProblem(['secret', 'set', '--bogus']).code, 64);
  assert.strictEqual(simpleOptionProblem(['env', 'shadow', '--bogus']).code, 64);
  assert.strictEqual(run(['vault', 'log', 'export', '--bogus']).status, 2);
});

test('evidence --verbose is not refused', () => {
  assert.notStrictEqual(run(['evidence', '--verbose']).status, 2);
});
