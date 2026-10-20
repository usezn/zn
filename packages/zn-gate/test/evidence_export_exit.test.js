'use strict';

// `evidence --export` and `export` still write the records, but exit 1 when the chain does not verify.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { logEvidence } = require('../lib/evidence');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function setup(tamper) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-exit-'));
  fs.mkdirSync(path.join(home, '.zn'));
  const file = path.join(home, '.zn', 'evidence.jsonl');
  logEvidence({ payload: 'example-1', tool_name: 'bash', verdict: 'block' }, file);
  logEvidence({ payload: 'example-2', tool_name: 'bash', verdict: 'allow' }, file);
  if (tamper) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('block', 'allow'));
  return home;
}

function run(home, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

const MSG = 'The export was written, but the log was changed or damaged, so do not rely on it as proof. Run zn-gate evidence --verify for details.';

for (const args of [['evidence', '--export'], ['export']]) {
  test(`${args.join(' ')}: good chain exits 0`, () => {
    const home = setup(false);
    const r = run(home, args);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.trim().length > 0);
    assert.ok(!r.stderr.includes(MSG));
  });

  test(`${args.join(' ')}: changed chain still writes the export and exits 1`, () => {
    const home = setup(true);
    const out = path.join(home, 'out.jsonl');
    const r = run(home, [...args, '--output', out]);
    assert.equal(r.status, 1);
    assert.ok(fs.readFileSync(out, 'utf8').trim().length > 0);
    assert.ok(r.stderr.includes(MSG));
    const screen = run(home, args);
    assert.equal(screen.status, 1);
    assert.ok(screen.stdout.trim().length > 0);
  });
}
