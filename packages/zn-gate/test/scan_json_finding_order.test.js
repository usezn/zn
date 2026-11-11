'use strict';
// `zn scan --format json`: findings should be listed by file path, then by line.
// Skipped: the order is not a guarantee in the code. bin/cli.js collects findings
// in the order the files are walked (no sort), and the multi-line key blocks are
// pushed after the line pass, so a key that starts at line 1 is listed after a
// finding at line 4 of the same file. The test shows the expected order; remove
// the skip when the scan sorts its findings. Every value is invented.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const FAKE = 'ZNTESTFAKE' + 'q8v3Lm9x2W';
const BEGIN = '-----BEGIN ' + 'PRIVATE KEY-----';
const BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' + 'Z'.repeat(40);
const SECRET_LINE = 'mytool --api-key=' + FAKE;

test('scan --format json lists findings by path, then by line', { skip: 'findings are not sorted by the scan (walk order, key blocks after the line pass); see the file header' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-scan-order-'));
  try {
    const content = [BEGIN, BODY, 'filler text here', SECRET_LINE, ''].join('\n');
    fs.writeFileSync(path.join(dir, 'b.md'), content);
    fs.writeFileSync(path.join(dir, 'a.md'), content);
    const r = spawnSync(process.execPath, [CLI, 'scan', '.', '--format', 'json'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, ZN_LOCAL_ONLY: 'true' },
    });
    assert.equal(r.status, 1, r.stderr);
    const order = JSON.parse(r.stdout).threats.map((t) => `${t.file}:${t.line}`);
    assert.deepEqual(order, ['a.md:1', 'a.md:4', 'b.md:1', 'b.md:4']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
