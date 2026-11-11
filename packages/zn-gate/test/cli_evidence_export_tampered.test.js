'use strict';

// `zn-gate evidence --export` on an altered log exits 1 like --verify, still writes the file and warns;
// a clean log exports with exit 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { logEvidence } = require('../lib/evidence');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cli-export-tamper-'));
  const file = path.join(home, '.zn', 'evidence.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { home, file, out: path.join(home, 'export.out') };
}

function run(home, args) {
  return spawnSync(process.execPath, [CLI, 'evidence', ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
  });
}

function writeTwo(file) {
  logEvidence({ payload: 'example-0', tool_name: 'bash' }, file);
  logEvidence({ payload: 'example-1', tool_name: 'bash' }, file);
}

function alter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const changed = text.replace('bash', 'bush');
  assert.notEqual(changed, text);
  fs.writeFileSync(file, changed);
}

test('export of an altered jsonl log exits 1, writes both records and warns', () => {
  const { home, file, out } = setup();
  writeTwo(file);
  alter(file);
  const r = run(home, ['--export', '--format', 'jsonl', '--output', out]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Tamper detected/);
  assert.match(r.stdout, /Exported 2 audit records/);
  assert.match(r.stdout, /Integrity: TAMPERED/);
  const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  for (const l of lines) JSON.parse(l);
});

test('export of an altered csv log exits 1 and still writes the header and rows', () => {
  const { home, file, out } = setup();
  writeTwo(file);
  alter(file);
  const r = run(home, ['--export', '--format', 'csv', '--output', out]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Tamper detected/);
  const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
  assert.match(lines[0], /^timestamp,verdict,/);
  assert.equal(lines.length - 1, 2);
});

test('export of a clean log exits 0 with no tamper warning', () => {
  const { home, file, out } = setup();
  writeTwo(file);
  const r = run(home, ['--export', '--output', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /Tamper detected/);
  assert.match(r.stdout, /Integrity: VALID/);
});
