'use strict';

// `zn-gate evidence --verify` and `--export` on a missing, empty, good and altered log.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { logEvidence } = require('../lib/evidence');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cli-ev-'));
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

test('verify on a missing log passes with zero records', () => {
  const { home } = setup();
  const r = run(home, ['--verify']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Total Records : 0/);
  assert.match(r.stdout, /ALL SHA-256 HASHES VERIFIED/);
});

test('verify on an empty log passes with zero records', () => {
  const { home, file } = setup();
  fs.writeFileSync(file, '');
  const r = run(home, ['--verify']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Total Records : 0/);
});

test('verify on a good log of two records passes', () => {
  const { home, file } = setup();
  writeTwo(file);
  const r = run(home, ['--verify']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Total Records : 2/);
  assert.match(r.stdout, /ALL SHA-256 HASHES VERIFIED/);
});

test('verify on a log with one changed byte exits 1', () => {
  const { home, file } = setup();
  writeTwo(file);
  const text = fs.readFileSync(file, 'utf8');
  const changed = text.replace('bash', 'bush');
  assert.notEqual(changed, text);
  fs.writeFileSync(file, changed);
  const r = run(home, ['--verify']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /TAMPER DETECTED AT RECORD 0/);
  assert.match(r.stdout, /Details:/);
});

test('export in jsonl writes both records to the output file', () => {
  const { home, file, out } = setup();
  writeTwo(file);
  const r = run(home, ['--export', '--format', 'jsonl', '--output', out]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Exported 2 audit records/);
  const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  for (const l of lines) JSON.parse(l);
});

test('export in csv writes a header and the same record count', () => {
  const { home, file, out } = setup();
  writeTwo(file);
  const r = run(home, ['--export', '--format', 'csv', '--output', out]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Exported 2 audit records/);
  const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
  assert.match(lines[0], /^timestamp,verdict,/);
  assert.equal(lines.length - 1, 2);
});
