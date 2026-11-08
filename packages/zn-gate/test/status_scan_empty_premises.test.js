'use strict';
// `zn-gate status` under NO_COLOR, and `zn-gate scan` on an empty folder.
// Premises checked against the product: status prints one row per fact, not one line per agent (todo below);
// scan on an empty folder exits 3 and says NOTHING SCANNED, by design (see cli_scan.test.js), so the
// "exit 0, clean" premise is todo. Fake values only; the home and the scanned folder are temporary.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const ESC = '\u001b';

function run(args, { home, noColor }) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: home, ZN_LOCAL_ONLY: 'true', ZN_STATS: 'off' };
  delete env.NO_COLOR;
  delete env.ZN_API_KEY;
  if (noColor) env.NO_COLOR = '1';
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
}

test('status with NO_COLOR set exits 0 and prints no escape codes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-status-nocolor-'));
  try {
    const r = run(['status'], { home, noColor: true });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('zn-gate Status'), r.stdout);
    assert.ok(r.stdout.includes('Package Version'), r.stdout);
    assert.equal(r.stdout.includes(ESC), false, 'no ANSI escape byte in the output');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('status prints one line per agent', { todo: 'premise false: status prints fixed fact rows (Package Version, Rules Version, Active Engine, Endpoint, API key, Leaves machine), not one line per agent. Product decision: whether status should list the agents it found.' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-status-agents-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const r = run(['status'], { home, noColor: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^.*claude.*$/im);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('scan of an empty folder exits 0 and reports a clean result', { todo: 'premise false: scan of an empty folder exits 3 and prints NOTHING SCANNED ("this is not a clean result"), a deliberate fail-closed rule pinned by cli_scan.test.js. Product decision if a clean exit is wanted.' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-scan-empty-home-'));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-scan-empty-dir-'));
  try {
    const r = run(['scan', empty], { home, noColor: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.includes('NOTHING SCANNED'), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('scan of an empty folder is not reported as clean (exit 3, NOTHING SCANNED)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-scan-empty-home-'));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-scan-empty-dir-'));
  try {
    const r = run(['scan', empty], { home, noColor: true });
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('NOTHING SCANNED'), r.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
