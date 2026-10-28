'use strict';

process.env.ZN_STATS = 'off';

// zn-gate evidence --export --output <file> that cannot be written: a plain reason and the next step, exit 1, never
// "Fatal error" with a raw code.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function exportTo(t, home, output) {
  return spawnSync(process.execPath, [CLI, 'evidence', '--export', '--output', output], {
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ZN_STATS: 'off' }, input: '', encoding: 'utf8', timeout: 30000,
  });
}

test('evidence --export to a file that cannot be written: plain reason, next step, exit 1', { skip: process.platform === 'win32' || isRoot }, (t) => {
  const home = tempDir(t, 'zn-export-err-');
  const ro = path.join(home, 'ro');
  fs.mkdirSync(ro, { mode: 0o500 });
  const cases = [
    [path.join(home, 'missing', 'out.jsonl'), /its folder does not exist/],
    [home, /that is a folder, not a file/],
    [path.join(ro, 'out.jsonl'), /your account is not allowed to write there/],
  ];
  try {
    for (const [output, why] of cases) {
      const r = exportTo(t, home, output);
      assert.equal(r.status, 1, output + ': ' + r.stderr);
      assert.ok(r.stderr.includes('zn-gate: could not write ' + output + ': '), r.stderr);
      assert.match(r.stderr, why);
      assert.match(r.stderr, /Choose another file with --output\./);
      assert.doesNotMatch(r.stderr, /Fatal error|ENOENT|EISDIR|EACCES/);
    }
  } finally { fs.chmodSync(ro, 0o700); }
});
