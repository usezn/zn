'use strict';
// `zn-gate evidence --export` without --format exports jsonl (docs/cli.md: "--format jsonl|csv", default
// jsonl) and exits 0. Run in an empty temporary home, so the ledger is absent and the export is empty:
// the default must match --format jsonl byte for byte and must not be the csv header.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const CSV_HEADER = 'timestamp,verdict,phase,tool_name,agent_environment,rule,reason,payload_sha256,record_hash,prev_hash,latency_us';

function run(t, args) {
  const home = tempDir(t, 'zn-evidence-default-home-');
  const cwd = tempDir(t, 'zn-evidence-default-cwd-');
  return spawnSync(process.execPath, [CLI, 'evidence', ...args], {
    cwd,
    input: '',
    encoding: 'utf8',
    timeout: 60000,
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, ZN_STATS: 'off', NO_COLOR: '1' },
  });
}

test('evidence --export with no --format exports jsonl and exits 0', (t) => {
  const r = run(t, ['--export']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, '', 'empty ledger: no jsonl records');
  assert.notEqual(r.stdout.split('\n')[0], CSV_HEADER);
});

test('evidence --export with no --format is the same as --format jsonl', (t) => {
  const dflt = run(t, ['--export']);
  const jsonl = run(t, ['--export', '--format', 'jsonl']);
  assert.equal(dflt.status, 0, dflt.stderr);
  assert.equal(jsonl.status, 0, jsonl.stderr);
  assert.equal(dflt.stdout, jsonl.stdout);
});
