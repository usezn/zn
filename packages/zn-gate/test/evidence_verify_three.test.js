'use strict';
// Three records appended through the library to a fresh ledger in a temporary home; `evidence --verify` on that
// home exits 0 and reports the three records as verified.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { logEvidence, verifyEvidenceLedger } = require('../lib/evidence');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

test('three appended records verify through the library and through evidence --verify (exit 0)', (t) => {
  const home = tempDir(t, 'zn-ev-verify3-');
  const file = path.join(home, '.zn', 'evidence.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  logEvidence({ payload: 'example-0', tool_name: 'bash' }, file);
  logEvidence({ payload: 'example-1', tool_name: 'read' }, file);
  logEvidence({ payload: 'example-2', tool_name: 'write' }, file);

  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 3);
  assert.deepEqual(verifyEvidenceLedger(file), { valid: true, total: 3, verified: 3, broken_index: null, error: null });

  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', ZN_STATS: 'off' };
  delete env.ZN_HOME;
  const r = spawnSync(process.execPath, [CLI, 'evidence', '--verify'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Total Records : 3/);
  assert.match(r.stdout, /ALL SHA-256 HASHES VERIFIED/);
});
