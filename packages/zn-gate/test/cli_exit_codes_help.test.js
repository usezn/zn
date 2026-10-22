'use strict';
// zn-gate scan, check, status and evidence refuse what they do not know (exit 2); secret, env, hooks and scan
// print their own usage for --help; a secret name that is already taken is not a wrong usage.
// These tests must never count into the real ~/.zn/stats.json.
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');
const { spawnSync } = require('child_process');
const cli = require('../lib/broker/cli');
const { createFakeVault } = require('./helpers/fake_vault');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function run(args, extraEnv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cli-codes-'));
  try {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, ZN_LOCAL_ONLY: 'true', ZN_STATS: 'off', NO_COLOR: '1', ...extraEnv },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

test('scan, check, doctor, status and evidence reject an unknown option with exit 2 and a usage line', () => {
  const cases = [
    [['scan', '.', '--bogus'], /usage: zn-gate scan /],
    [['scan', '--bogus'], /usage: zn-gate scan /],
    [['check', '--bogus'], /usage: zn-gate check/],
    [['doctor', '--bogus'], /usage: zn-gate check/],
    [['status', '--bogus'], /usage: zn-gate status/],
    [['evidence', '--bogus'], /usage: zn-gate evidence /],
    [['logs', '--bogus'], /usage: zn-gate evidence /],
    [['export', '--bogus'], /usage: zn-gate evidence /],
  ];
  for (const [args, usage] of cases) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' ') + ' exited ' + r.status + ': ' + r.stdout.slice(0, 200) + r.stderr);
    assert.match(r.stderr, /Unknown option "--bogus"/, args.join(' '));
    assert.match(r.stderr, usage, args.join(' '));
    assert.equal(r.stdout, '', args.join(' ') + ' printed a report');
  }
});

test('an option without its value, an "=" value and a stray word are usage errors too', () => {
  for (const args of [['scan', '.', '--format'], ['scan', '--exclude'], ['evidence', '--tail'], ['evidence', '--export', '--output']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /needs a value/, args.join(' '));
  }
  const eq = run(['scan', '.', '--format=json']);
  assert.equal(eq.status, 2);
  assert.match(eq.stderr, /Write the value after a space/);
  for (const args of [['status', 'extra'], ['check', 'extra'], ['evidence', 'extra'], ['scan', 'a', 'b']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /Unexpected argument/, args.join(' '));
  }
});

test('evidence --export with a format it does not know exits 2', () => {
  for (const args of [['evidence', '--export', '--format', 'xml'], ['export', '--format', 'xml'], ['evidence', '--format', 'xml']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' ') + ': ' + r.stdout.slice(0, 100) + r.stderr);
    assert.match(r.stderr, /--format must be jsonl or csv/);
  }
  const ok = run(['evidence', '--export', '--format', 'csv']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^timestamp,verdict/);
});

test('the commands still work with the options they take', () => {
  assert.equal(run(['status']).status, 0);
  assert.equal(run(['status', '--local-only', '--verbose']).status, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cli-scan-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), 'hello there\n');
    const r = run(['scan', '--format', 'json', dir]);
    assert.equal(r.status, 0, r.stderr);
    // The folder after the option is the one scanned (it used to be ignored, and the current folder scanned).
    assert.equal(JSON.parse(r.stdout).total_files, 1);
    assert.equal(run(['scan', dir, '--all', '--include', '.rst', '--exclude', 'x', '--include-home', '--format', 'github']).status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('secret, env, hooks and scan --help print their own usage, not the general help', () => {
  const cases = [
    [['secret', '--help'], 'usage: zn secret '],
    [['secret', '-h'], 'usage: zn secret '],
    [['secrets', '--help'], 'usage: zn secret '],
    [['env', '--help'], 'usage: zn env '],
    [['hooks', '--help'], 'usage: zn hooks '],
    [['scan', '--help'], 'usage: zn-gate scan '],
    [['scan', '-h'], 'usage: zn-gate scan '],
  ];
  for (const [args, usage] of cases) {
    const r = run(args);
    assert.equal(r.status, 0, args.join(' ') + ': ' + r.stderr);
    assert.equal(r.stdout.split('\n')[0].startsWith(usage), true, args.join(' ') + ' printed: ' + r.stdout.slice(0, 100));
    assert.doesNotMatch(r.stdout, /zn-gate v\d|^USAGE:/m, args.join(' ') + ' printed the general help');
  }
  // Commands without a usage of their own keep the general help.
  assert.match(run(['run', '--help']).stdout, /^USAGE:/m);
});

test('zn secret set for a name that is already stored exits 1 (not 64) and says --force', async () => {
  const vault = createFakeVault();
  const base = { vault, human: true, readSecret: async () => 'hunter2-hunter2' };
  assert.equal(await cli.dispatch('secret', ['set', 'FOO'], { ...base, stderr: sink(), stdout: sink() }), 0);
  const err = sink();
  const code = await cli.dispatch('secret', ['set', 'FOO'], { ...base, stderr: err, stdout: sink() });
  assert.equal(code, 1);
  assert.match(err.text(), /FOO already exists; use --force to replace it/);
  assert.equal(await cli.dispatch('secret', ['set', 'FOO', '--force'], { ...base, stderr: sink(), stdout: sink() }), 0);
  // A usage mistake is still 64.
  assert.equal(await cli.dispatch('secret', ['set', 'FOO', 'value-in-argv'], { ...base, stderr: sink(), stdout: sink() }), 64);
});
