'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const { version } = require('../package.json');

function run(arg, cwd) {
  return spawnSync(process.execPath, [CLI, arg], { encoding: 'utf8', cwd });
}

test('version, -V and --version print the same text and exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-version-'));
  try {
    const results = ['version', '-V', '--version'].map((a) => run(a, dir));
    for (const r of results) {
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stderr, '');
      const first = r.stdout.split('\n')[0];
      assert.ok(first.includes(version), 'first line holds the package version');
    }
    assert.strictEqual(results[1].stdout, results[0].stdout);
    assert.strictEqual(results[2].stdout, results[0].stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
