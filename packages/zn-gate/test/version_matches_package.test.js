'use strict';
// `zn-gate version` prints one line that carries the package version from package.json, exits 0 and
// writes nothing to stderr. The line is "zn-gate <version> (rules engine: ...; ...)", so the version is
// the second word, and the rest of the line holds the rules versions. `zn-gate --version` (docs/cli.md:
// `-v`, `-V` and `--version` do the same) prints the same bytes as `version`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const { version } = require('../package.json');

function runCli(dir, args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: dir, input: '' });
}

test('version prints exactly one line with the package.json version and exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-version-line-'));
  try {
    const r = runCli(dir, ['version']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.ok(r.stdout.endsWith('\n'), 'the line ends with a newline');
    const lines = r.stdout.split('\n').slice(0, -1);
    assert.equal(lines.length, 1, 'exactly one line: ' + JSON.stringify(r.stdout));
    const m = /^zn-gate (\S+) \(/.exec(lines[0]);
    assert.ok(m, 'the line starts with "zn-gate <version> ("');
    assert.equal(m[1], version);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--version exits 0 and prints the same output as version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-version-flag-'));
  try {
    const byWord = runCli(dir, ['version']);
    const byFlag = runCli(dir, ['--version']);
    assert.equal(byWord.status, 0, byWord.stderr);
    assert.equal(byFlag.status, 0, byFlag.stderr);
    assert.equal(byFlag.stderr, '');
    assert.equal(byFlag.stdout, byWord.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
