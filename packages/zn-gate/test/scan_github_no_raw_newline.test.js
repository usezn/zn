'use strict';
// `zn-gate scan --format github` writes one workflow command per line. A file name with a line break
// in it must come out escaped (%0A), never as a raw line break that would start a fake command.
// Every value is an invented one; the key is assembled at runtime.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const FAKE = 'ZNTESTFAKE' + 'q8v3Lm9x2W';

test('scan --format github: a file name with a line break is escaped, one command per line', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-gh-newline-')));
  try {
    // A line break, a percent sign and a comma: the three characters a workflow command must escape.
    const name = 'x%y,z\nw.md';
    try {
      fs.writeFileSync(path.join(dir, name), `mytool --api-key=${FAKE}\n`);
    } catch (err) {
      t.skip('filesystem refuses a line break in file names: ' + err.code);
      return;
    }
    const r = spawnSync(process.execPath, [CLI, 'scan', dir, '--format', 'github'], {
      encoding: 'utf8',
      env: { ...process.env, ZN_LOCAL_ONLY: 'true', ZN_STATS: 'off' },
    });
    assert.strictEqual(r.status, 1, r.stderr);
    assert.ok(!r.stdout.includes(FAKE), 'the value was printed');
    assert.ok(!r.stdout.includes('x%y,z\nw'), 'the raw file name was printed');

    // Each line is either a workflow command, the summary, or blank: no continuation of a command.
    for (const line of r.stdout.split('\n')) {
      assert.ok(line === '' || line.startsWith('::') || line.startsWith('[zn-gate]'), 'stray line: ' + JSON.stringify(line));
    }
    const errors = r.stdout.split('\n').filter((l) => l.startsWith('::error '));
    assert.strictEqual(errors.length, 1, r.stdout);
    assert.match(errors[0], /^::error file=.*x%25y%2Cz%0Aw\.md,line=1,title=Secret found \(/);
    assert.match(errors[0], /\)::Next: /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
