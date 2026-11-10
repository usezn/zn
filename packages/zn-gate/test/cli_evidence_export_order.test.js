'use strict';

// `zn-gate evidence --export --format jsonl` writes the records in ledger order.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { logEvidence } = require('../lib/evidence');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cli-ev-order-'));
  const file = path.join(home, '.zn', 'evidence.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { home, file, out: path.join(home, 'export.jsonl') };
}

test('evidence --export --format jsonl keeps records in ledger order', () => {
  const { home, file, out } = setup();
  const tools = ['tool-a', 'tool-b', 'tool-c', 'tool-d'];
  for (const tool_name of tools) logEvidence({ payload: `example-${tool_name}`, tool_name }, file);
  const ledger = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  const r = spawnSync(process.execPath, [CLI, 'evidence', '--export', '--format', 'jsonl', '--output', out], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  const exported = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(exported.map((x) => x.tool_name), tools);
  assert.deepEqual(exported.map((x) => x.record_hash), ledger.map((x) => x.record_hash));
});
