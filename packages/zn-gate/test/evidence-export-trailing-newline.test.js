'use strict';
// `zn-gate evidence --export --format jsonl` ends its output with exactly one newline,
// whether the ledger on disk ends with a newline or not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { logEvidence } = require('../lib/evidence');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function setup() {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-b5067-ev-'));
  const file = path.join(home, '.zn', 'evidence.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  logEvidence({ payload: 'example-0', tool_name: 'bash' }, file);
  logEvidence({ payload: 'example-1', tool_name: 'bash' }, file);
  return { home, file, out: path.join(home, 'export.jsonl') };
}

function exportJsonl(home, out) {
  return spawnSync(process.execPath, [CLI, 'evidence', '--export', '--format', 'jsonl', '--output', out], {
    encoding: 'utf8',
    timeout: 30000,
    env: { PATH: process.env.PATH || '', HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn'), TMPDIR: home, NO_COLOR: '1', ZN_STATS: 'off', ZN_LOCAL_ONLY: 'true' },
  });
}

function assertOneTrailingNewline(text) {
  assert.ok(text.endsWith('\n'), 'the export ends with a newline');
  assert.ok(!text.endsWith('\n\n'), 'the export does not end with a blank line');
  assert.strictEqual(text.split('\n').length - 1, 2, 'two records, one line each');
}

test('evidence --export --format jsonl ends with exactly one newline', () => {
  const { home, out } = setup();
  try {
    const r = exportJsonl(home, out);
    assert.strictEqual(r.status, 0, r.stderr);
    assertOneTrailingNewline(fs.readFileSync(out, 'utf8'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('evidence --export --format jsonl adds the missing newline when the ledger has none', () => {
  const { home, file, out } = setup();
  try {
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n+$/, ''));
    const r = exportJsonl(home, out);
    assert.strictEqual(r.status, 0, r.stderr);
    assertOneTrailingNewline(fs.readFileSync(out, 'utf8'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
