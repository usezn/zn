'use strict';

// `zn-gate scan <file>` reports a Google API key in a file, exits 1, and never prints the key value.
// The key is fake: the AIza prefix and 35 URL-safe characters, with no real account behind it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const FAKE_GOOGLE_KEY = 'AIza' + 'FAKE'.repeat(8) + 'FAK';

function scan(target, format) {
  return spawnSync(process.execPath, [CLI, 'scan', target, '--format', format], {
    encoding: 'utf8',
    env: { ...process.env, ZN_LOCAL_ONLY: 'true' },
  });
}

test('scan reports a fake Google API key in a file, exits 1 and does not print the key', (t) => {
  const dir = tempDir(t, 'zn-scan-google-key-');
  const file = path.join(dir, 'app.env');
  fs.writeFileSync(file, 'config\nGOOGLE_API_KEY=' + FAKE_GOOGLE_KEY + '\n');

  const json = scan(file, 'json');
  assert.strictEqual(json.status, 1, json.stdout + json.stderr);
  const data = JSON.parse(json.stdout);
  assert.strictEqual(data.total_threats, 1);
  assert.strictEqual(data.threats[0].type, 'secret_leak');
  assert.strictEqual(data.threats[0].line, 2);

  const text = scan(file, 'text');
  assert.strictEqual(text.status, 1, text.stdout + text.stderr);

  for (const out of [json.stdout, json.stderr, text.stdout, text.stderr]) {
    assert.ok(!out.includes(FAKE_GOOGLE_KEY), 'the key value was printed');
  }
});
