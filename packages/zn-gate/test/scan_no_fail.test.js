'use strict';
// `zn-gate scan --no-fail`: report only. The full report is printed and the exit code is always 0,
// the same in the npm and the Python CLI (the GitHub Action relies on the Python one).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const PY_SRC = path.join(__dirname, '..', '..', 'zn-gate-py', 'src');
const FAKE_AWS = 'AKIA' + 'ZNTESTFAKE' + '000000';
const ENV = { ...process.env, ZN_LOCAL_ONLY: 'true', PYTHONDONTWRITEBYTECODE: '1' };

function node(args) {
  return spawnSync(process.execPath, [CLI, 'scan', ...args], { encoding: 'utf8', env: ENV, maxBuffer: 64 * 1024 * 1024 });
}

function python(args) {
  return spawnSync('python3', ['-I', '-X', 'utf8', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); sys.argv = ["zn-gate"] + sys.argv[2:]; from zn_gate.cli import main; sys.exit(main())', PY_SRC, 'scan', ...args], {
    encoding: 'utf8', env: ENV, maxBuffer: 64 * 1024 * 1024,
  });
}

function withDir(files, fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-nofail-')));
  try {
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const CASES = {
  finding: { 'notes.md': 'hello\n', 'creds.env': 'AWS_ACCESS_KEY_ID=' + FAKE_AWS + '\n' },
  clean: { 'ok.md': 'hello there, nothing to see\n' },
  empty: {},
};

for (const [name, files] of Object.entries(CASES)) {
  test('npm and Python agree on exit codes for the "' + name + '" project, with and without --no-fail', () => {
    withDir(files, (dir) => {
      const plain = [node([dir, '--format', 'json']), python([dir, '--format', 'json'])];
      assert.strictEqual(plain[0].status, plain[1].status, plain[0].stderr + plain[1].stderr);
      const noFail = [node([dir, '--format', 'json', '--no-fail']), python([dir, '--format', 'json', '--no-fail'])];
      assert.strictEqual(noFail[0].status, 0, noFail[0].stderr);
      assert.strictEqual(noFail[1].status, 0, noFail[1].stderr);
    });
  });
}

test('without --no-fail a finding exits 1 in both CLIs; with it the report is the same and the exit is 0', () => {
  withDir(CASES.finding, (dir) => {
    assert.strictEqual(node([dir]).status, 1);
    assert.strictEqual(python([dir]).status, 1);
    const n = node([dir, '--format', 'json', '--no-fail']);
    const p = python([dir, '--format', 'json', '--no-fail']);
    assert.strictEqual(n.status, 0, n.stderr);
    assert.strictEqual(p.status, 0, p.stderr);
    const nj = JSON.parse(n.stdout);
    const pj = JSON.parse(p.stdout);
    assert.ok(nj.threats.length >= 1, 'the npm report still lists the finding');
    assert.strictEqual(nj.threats.length, pj.threats.length);
  });
});

test('--no-fail keeps the text and github reports and works with --allow-partial', () => {
  withDir(CASES.finding, (dir) => {
    const text = node([dir, '--no-fail']);
    assert.strictEqual(text.status, 0, text.stderr);
    assert.match(text.stdout, /FAILED/);
    const gh = node([dir, '--format', 'github', '--no-fail']);
    assert.strictEqual(gh.status, 0, gh.stderr);
    assert.match(gh.stdout, /::error/);
    assert.strictEqual(node([dir, '--allow-partial', '--no-fail']).status, 0);
  });
});

test('a missing path still exits 1 with --no-fail in npm (it is not a scan result)', () => {
  const missing = path.join(os.tmpdir(), 'zn-nofail-does-not-exist-' + process.pid);
  assert.strictEqual(node([missing, '--no-fail']).status, python([missing, '--no-fail']).status);
});

test('scan --help text and the unknown-option message list --no-fail', () => {
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', env: ENV });
  assert.match(r.stdout, /--no-fail/);
  const bad = node(['--frob']);
  assert.strictEqual(bad.status, 2);
  assert.match(bad.stderr, /--no-fail/);
});
