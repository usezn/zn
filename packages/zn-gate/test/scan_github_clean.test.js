'use strict';
// `zn scan --format github` on a clean directory prints no ::error, ::warning or ::notice
// annotation and exits 0. Only the closing summary line is printed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

test('scan --format github: a clean directory prints no annotation and exits 0', (t) => {
  const dir = tempDir(t, 'zn-scan-gh-clean-');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Example project\n\nNothing to see here.\n');
  fs.writeFileSync(path.join(dir, 'main.js'), 'console.log("hello");\n');
  const r = spawnSync(process.execPath, [CLI, 'scan', dir, '--format', 'github'], {
    encoding: 'utf8',
    env: { ...process.env, ZN_LOCAL_ONLY: 'true', ZN_STATS: 'off' },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, /^::(error|warning|notice)\b/m, r.stdout);
  assert.match(r.stdout, /Scanned [0-9]+ files .*Found 0 secrets and 0 security threats\./);
});
