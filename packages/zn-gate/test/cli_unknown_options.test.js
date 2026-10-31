'use strict';
// scan and analyze refuse an option they do not take: they name it, list the options of the command and exit 2.
// Options after a bare "--" and text that does not start with "--" stay positional.
// The secret in the scan fixture is an invented value assembled at runtime.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const FAKE_AWS = 'AKIA' + 'ZNTESTFAKE' + '000000';

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input: '',
    cwd: opts.cwd,
    env: Object.assign({}, process.env, { NO_COLOR: '1', ZN_STATS: 'off', ZN_LOCAL_ONLY: 'true' }),
  });
}

test('analyze with an unknown option names it, lists its options and exits 2', () => {
  const r = run(['analyze', '--bogus', 'some text']);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown option "--bogus"/);
  assert.match(r.stderr, /--key, --stage, --url, --long-input, --local-only, --verbose/);
  assert.match(r.stderr, /put "--" before it/);
  assert.doesNotMatch(r.stderr, /provide text/);
  assert.strictEqual(r.stdout, '');
});

test('analyze with an unknown option and no text still reports the option', () => {
  const r = run(['analyze', '--bogus']);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown option "--bogus"/);
});

test('analyze accepts its own options and analyzes the text after them', () => {
  const r = run(['analyze', '--local-only', 'hello there']);
  assert.notStrictEqual(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /unknown option/);
  assert.match(r.stdout, /"verdict"/);
});

test('analyze skips the value of an option that takes one', () => {
  const r = run(['analyze', '--stage', 'v30', 'hello there']);
  assert.notStrictEqual(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /unknown option/);
  assert.match(r.stdout, /"verdict"/);
});

test('analyze -- analyzes text that starts with dashes', () => {
  const r = run(['analyze', '--local-only', '--', '--bogus text here']);
  assert.doesNotMatch(r.stderr, /unknown option|provide text/);
  assert.match(r.stdout, /"verdict"/);
});

test('analyze with --option=value says to use two arguments', () => {
  const r = run(['analyze', '--stage=v30', 'hello']);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /--stage VALUE/);
});

test('scan with an unknown option names it, lists its options and exits 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-b2247-'));
  try {
    const r = run(['scan', '--bogus'], { cwd: dir });
    assert.strictEqual(r.status, 2, r.stderr);
    assert.match(r.stderr, /unknown option "--bogus"/);
    assert.match(r.stderr, /--format, --include, --exclude, --code, --all, --allow-partial, --include-home/);
    assert.strictEqual(r.stdout, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scan with an unknown option after a folder is refused too', () => {
  const r = run(['scan', '.', '--dry-run']);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown option "--dry-run"/);
});

test('scan with --format=json says to use two arguments', () => {
  const r = run(['scan', '.', '--format=json']);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /--format VALUE/);
});

test('scan reads the folder that comes after its options', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-b2247-'));
  const empty = path.join(base, 'empty');
  const target = path.join(base, 'target');
  fs.mkdirSync(empty);
  fs.mkdirSync(target);
  try {
    fs.writeFileSync(path.join(target, 'settings.env'), `AWS_ACCESS_KEY_ID=${FAKE_AWS}\n`);
    const r = run(['scan', '--format', 'text', target], { cwd: empty });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /SECRET\(S\) FOUND/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('scan -- takes a folder whose name starts with dashes', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-b2247-'));
  const target = path.join(base, '--odd');
  fs.mkdirSync(target);
  try {
    fs.writeFileSync(path.join(target, 'settings.env'), `AWS_ACCESS_KEY_ID=${FAKE_AWS}\n`);
    const r = run(['scan', '--', '--odd'], { cwd: base });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /SECRET\(S\) FOUND/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('scan accepts its own options without reporting an unknown option', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-b2247-'));
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Notes\n\nNothing to see here.\n');
    const r = run(['scan', dir, '--code', '--allow-partial', '--exclude', 'legacy', '--include', '.rst']);
    assert.doesNotMatch(r.stderr, /unknown option|needs a value/);
    assert.notStrictEqual(r.status, 2, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
