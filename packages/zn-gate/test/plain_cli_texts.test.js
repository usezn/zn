'use strict';
// Plain-language wording of the common CLI messages. Wording only: exit codes stay the same.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function run(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd });
}

test('scan of a missing path says what to do and shows an example', () => {
  const r = run(['scan', path.join(os.tmpdir(), 'zn-no-such-dir-b59')]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Error: Target path does not exist/);
  assert.match(r.stderr, /Example: zn-gate scan \./);
});

test('scan with a bad --format shows an example', () => {
  const r = run(['scan', '.', '--format', 'xml']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /must be text, json or github\nExample: zn-gate scan \. --format json/);
});

test('--long-input error shows an example', () => {
  const r = run(['analyze', '--long-input', 'bogus', 'hello']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /Example: zn-gate analyze --long-input windows/);
});

test('scan reports a secret in plain words, without DLP jargon', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-b59-'));
  try {
    // Obviously fake key assembled at runtime so no secret pattern sits in the source.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'key = AKIA' + 'IOSFODNN7' + 'EXAMPLE\n');
    const r = run(['scan', dir, '--format', 'json']);
    assert.doesNotMatch(r.stdout + r.stderr, /DLP/);
    assert.match(r.stdout, /A real-looking secret is stored in plain text here/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
