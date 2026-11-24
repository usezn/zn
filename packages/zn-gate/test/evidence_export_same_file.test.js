'use strict';
process.env.ZN_STATS = 'off';

// `evidence --export --output` never writes over the evidence log itself, nor over a link or a hard link to it.
// The check runs before the output is opened, so the log is left as it was and the command exits 2.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');
const ev = require('../lib/evidence');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const REFUSAL = /the output file is the evidence log itself; choose another path/;

function tryCreateLink(t, makeLink, reason) {
  try {
    makeLink();
    return true;
  } catch (err) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(err && err.code)) {
      t.skip(reason);
      return false;
    }
    throw err;
  }
}

function setup(t) {
  const home = tempDir(t, 'zn-export-same-');
  const file = path.join(home, '.zn', 'evidence.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    const r = ev.logEvidence({
      agent: 'test-agent', phase: 'tool-call', tool_name: `tool${i}`, payload: `payload ${i}`,
      verdict: 'allow', latency_us: i, engine: 'test',
    }, file, { noStats: true });
    assert.ok(r, 'record written');
  }
  return { home, file };
}

function run(home, args) {
  return spawnSync(process.execPath, [CLI, 'evidence', ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
  });
}

function assertRefused(r, file, before) {
  assert.equal(r.status, 2);
  assert.match(r.stderr, REFUSAL);
  assert.ok(before.length > 0, 'the log had records before the export');
  assert.ok(fs.readFileSync(file).equals(before), 'the evidence log is unchanged');
}

test('export onto the evidence log path itself is refused and the log is kept', (t) => {
  const { home, file } = setup(t);
  const before = fs.readFileSync(file);
  const r = run(home, ['--export', '--format', 'jsonl', '--output', file]);
  assertRefused(r, file, before);
});

test('export onto a symlink to the evidence log is refused and the log is kept', (t) => {
  const { home, file } = setup(t);
  const link = path.join(home, 'alias.jsonl');
  if (!tryCreateLink(t, () => fs.symlinkSync(file, link), 'symbolic links need privileges on Windows')) return;
  const before = fs.readFileSync(file);
  const r = run(home, ['--export', '--format', 'jsonl', '--output', link]);
  assertRefused(r, file, before);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is still a link');
});

test('export onto a hard link to the evidence log is refused and the log is kept', (t) => {
  const { home, file } = setup(t);
  const hard = path.join(home, 'copy.jsonl');
  if (!tryCreateLink(t, () => fs.linkSync(file, hard), 'hard links are refused on this Windows filesystem')) return;
  const before = fs.readFileSync(file);
  const r = run(home, ['--export', '--format', 'jsonl', '--output', hard]);
  assertRefused(r, file, before);
});

test('export to a normal different path still works and leaves the log alone', (t) => {
  const { home, file } = setup(t);
  const before = fs.readFileSync(file);
  const out = path.join(home, 'export.out');
  const r = run(home, ['--export', '--format', 'jsonl', '--output', out]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Exported 2 audit records/);
  const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  for (const l of lines) JSON.parse(l);
  assert.ok(fs.readFileSync(file).equals(before), 'the evidence log is unchanged');
});
