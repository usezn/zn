'use strict';
// evidence --export refuses a --format it does not know, and still exports jsonl and csv.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

function run(args, extraEnv) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input: '',
    env: Object.assign({}, process.env, { NO_COLOR: '1', ZN_STATS: 'off', ZN_LOCAL_ONLY: 'true' }, extraEnv || {}),
  });
}

test('evidence --export with an unknown --format exits 2 and lists the valid formats', () => {
  const r = run(['evidence', '--export', '--format', 'xml']);
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /unknown --format "xml"/);
  assert.match(r.stderr, /jsonl and csv/);
});

test('export with an unknown --format is refused the same way', () => {
  const r = run(['export', '--format', 'xml']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /jsonl and csv/);
});

test('evidence --export still works with jsonl and csv', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-evidence-format-'));
  try {
    for (const format of ['jsonl', 'csv']) {
      const r = run(['evidence', '--export', '--format', format], { HOME: home, USERPROFILE: home });
      assert.strictEqual(r.status, 0, format + ': ' + r.stderr);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
