'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-report-range-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function run(args) {
  const env = { ...process.env, ZN_HOME: home, HOME: home, USERPROFILE: home };
  delete env.ZN_STATS;
  return spawnSync(process.execPath, [CLI, 'report', ...args], { encoding: 'utf8', input: '', env });
}

test('report --since accepts the ends of the 1d to 90d range and exits 0', () => {
  for (const v of ['1d', '7d', '90d']) {
    const r = run(['--since', v]);
    assert.strictEqual(r.status, 0, `${v}: ${r.stderr}`);
    assert.match(r.stdout, /^zn-gate report: /);
  }
});

test('report --since outside the range or without a unit prints usage and exits 2', () => {
  for (const v of ['91d', '0d', '7']) {
    const r = run(['--since', v]);
    assert.strictEqual(r.status, 2, v);
    assert.match(r.stdout, /^Usage: zn-gate report /, v);
  }
});

test('report --since with --json prints valid JSON for a valid range', () => {
  const r = run(['--since', '7d', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.days, 7);
});

test('report --since with --json still exits 2 for a bad range and prints no JSON', () => {
  const r = run(['--since', '91d', '--json']);
  assert.strictEqual(r.status, 2);
  assert.throws(() => JSON.parse(r.stdout));
});

test('report --since with --no-team-line exits 0 for a valid range and 2 for a bad one', () => {
  const ok = run(['--since', '7d', '--no-team-line']);
  assert.strictEqual(ok.status, 0, ok.stderr);
  const bad = run(['--since', '0d', '--no-team-line']);
  assert.strictEqual(bad.status, 2);
});
