'use strict';

process.env.ZN_STATS = 'off';

// `evidence --export --output <folder it cannot write to>` says what is wrong in plain words and exits with 1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

test('evidence --export to a folder that cannot be written prints a plain message and exits 1', (t) => {
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return t.skip('needs a non-root POSIX user');
  const home = tempDir(t, 'zn-export-home-');
  const ro = tempDir(t, 'zn-export-ro-');
  fs.chmodSync(ro, 0o500);
  t.after(() => { try { fs.chmodSync(ro, 0o700); } catch (_) { /* already removed */ } });
  const out = path.join(ro, 'evidence.jsonl');
  const r = spawnSync(process.execPath, [CLI, 'evidence', '--export', '--output', out], {
    env: { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stderr.includes(out), r.stderr);
  assert.match(r.stderr, /not allowed/);
  assert.doesNotMatch(r.stderr, /EACCES|Fatal error/);
});
