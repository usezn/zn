'use strict';
// In a fresh home, `stats share status` says sharing is off (the default) and writes no file.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

test('stats share status in a fresh home says sharing is off and writes no file', (t) => {
  const home = tempDir(t, 'zn-share-default-home-');
  const cwd = tempDir(t, 'zn-share-default-cwd-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', ZN_STATS: 'off' };
  delete env.ZN_HOME;
  const before = filesUnder(home);
  assert.deepEqual(before, []);

  const r = spawnSync(process.execPath, [CLI, 'stats', 'share', 'status'], { cwd, input: '', encoding: 'utf8', env, timeout: 60000 });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, 'Sharing pseudonymous daily counts: off (the default).\n');
  assert.deepEqual(filesUnder(home), before, 'no file was written in the home folder');
});
