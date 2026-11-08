'use strict';
/*
 * `zn disconnect` run as a real command (bin/cli.js) with a temporary ZN_HOME and no saved key.
 * Without a person at the terminal it must refuse and remove nothing.
 * The "not connected" path is checked as a todo: the terminal guard runs before the saved-key check,
 * so a non-interactive run never reaches "Not connected. Nothing to remove.".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function disconnect(home, args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn') };
  delete env.ZN_VERBOSE;
  delete env.DEBUG;
  return spawnSync(process.execPath, [CLI, 'disconnect', ...args], { env, encoding: 'utf8', input: '', timeout: 30000 });
}

test('zn disconnect without a terminal and with no saved key refuses, removes nothing and exits 1', (t) => {
  const home = tempDir(t, 'zn-disconnect-');
  const r = disconnect(home, []);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /zn-gate disconnect needs an interactive terminal\./);
  assert.match(r.stderr, /Nothing was removed or revoked\./);
  assert.equal(r.stdout, '', 'nothing was printed as if it had worked');
});

test('zn disconnect with no saved key exits 0 and says there is nothing to remove',
  { todo: 'lib/connect-cli.js disconnect() calls requireHuman() before readMarker(), so a non-interactive run exits 1 first; the not-connected path is only tested in-process with a fake terminal' },
  (t) => {
    const home = tempDir(t, 'zn-disconnect-');
    const r = disconnect(home, []);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Not connected\. Nothing to remove\./);
    assert.equal(r.stderr, '');
  });
