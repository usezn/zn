'use strict';
// `zn env shadow <file>` on a file that does not exist exits 1 and names the path. The file is read before
// the vault is touched, and the error reads "<path> does not exist, or a folder on its path is missing."
// (lib/errors.js). A test process has no terminal, so the in-process call passes human: true to get past
// the terminal check, the same as env_shadow_short.test.js. The real CLI, run without a terminal, refuses
// first with exit 77 and names no path (docs/secrets.md: the command needs a terminal). Both are asserted.
// Every path is inside a temporary folder.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Writable } = require('stream');

const cli = require('../lib/broker/cli');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

test('env shadow on a missing .env exits 1, names the path and creates no file', async (t) => {
  const dir = tempDir(t, 'zn-shadow-missing-');
  const missing = path.join(dir, '.env');
  const stdout = sink();
  const stderr = sink();
  const rc = await cli.dispatch('env', ['shadow', '.env'], { cwd: dir, home: dir, stdout, stderr, human: true });
  assert.equal(rc, 1);
  assert.equal(stdout.text(), '');
  assert.ok(stderr.text().includes(missing), 'the error names the path: ' + JSON.stringify(stderr.text()));
  assert.match(stderr.text(), /does not exist/);
  assert.equal(fs.existsSync(missing), false);
});

test('env shadow on a missing .env without a terminal exits 77 and creates no file', (t) => {
  const dir = tempDir(t, 'zn-shadow-notty-');
  const r = spawnSync(process.execPath, [CLI, 'env', 'shadow', '.env'], {
    cwd: dir,
    input: '',
    encoding: 'utf8',
    timeout: 60000,
    env: { HOME: dir, USERPROFILE: dir, PATH: process.env.PATH, ZN_STATS: 'off', NO_COLOR: '1' },
  });
  assert.equal(r.status, 77, r.stderr);
  assert.match(r.stderr, /interactive terminal/);
  assert.equal(fs.existsSync(path.join(dir, '.env')), false);
});
