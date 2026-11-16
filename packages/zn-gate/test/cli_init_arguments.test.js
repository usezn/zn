'use strict';

// zn-gate init on the real command line, in a temporary HOME with no agent config: an unknown argument is refused
// with exit 2, and --dry-run, --shadow and --revert each select --wrap-mcp without changing any file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function listAll(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(path.relative(dir, p));
      if (e.isDirectory()) walk(p);
    }
  })(dir);
  return out.sort();
}

function runInit(home, cwd, args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData'), ZN_STATS: 'off' };
  return spawnSync(process.execPath, [CLI, 'init', ...args], { cwd, env, input: '', encoding: 'utf8', timeout: 60000 });
}

test('init with an unknown argument exits 2 with a plain message and changes nothing', (t) => {
  const home = tempDir(t, 'zn-init-args-home-');
  const cwd = tempDir(t, 'zn-init-args-cwd-');
  const r = runInit(home, cwd, ['--no-such-flag']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^zn-gate init: unknown argument "--no-such-flag"\./);
  assert.equal(r.stdout, '');
  assert.deepEqual(listAll(home), []);
  assert.deepEqual(listAll(cwd), []);
});

for (const flag of ['--dry-run', '--shadow', '--revert']) {
  test('init ' + flag + ' selects --wrap-mcp and changes no file without any agent config', (t) => {
    const home = tempDir(t, 'zn-init-args-home-');
    const cwd = tempDir(t, 'zn-init-args-cwd-');
    const r = runInit(home, cwd, [flag]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /unknown argument/);
    assert.match(r.stdout, /Done\. Checked \d+ environment configurations \(0 modified\)\./);
    assert.match(r.stdout, /Not installed\/configured/);
    assert.deepEqual(listAll(home), []);
    assert.deepEqual(listAll(cwd), []);
  });
}
