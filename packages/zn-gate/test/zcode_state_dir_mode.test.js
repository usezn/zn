'use strict';
/**
 * The zcode enabled-state folder (<home>/.zn/state) is created owner-only, whatever the
 * process umask is, and an existing looser folder is closed again. Every test uses its own
 * temporary home; ZN_HOME is unset for the test so the real ~/.zn is never touched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const zc = require('../lib/agents').getAdapter('zcode');
const { tempDir } = require('./helpers/tmp');

const POSIX = process.platform !== 'win32';
const cliFile = (home) => path.join(home, '.zcode', 'cli', 'config.json');
const stateDir = (home) => path.join(home, '.zn', 'state');

function writeConfig(home, obj) {
  fs.mkdirSync(path.dirname(cliFile(home)), { recursive: true });
  fs.writeFileSync(cliFile(home), JSON.stringify(obj, null, 2));
}

/** Unsets ZN_HOME for the test and puts it back afterwards. */
function isolateZnHome(t) {
  const saved = process.env.ZN_HOME;
  delete process.env.ZN_HOME;
  t.after(() => { if (saved !== undefined) process.env.ZN_HOME = saved; });
}

/** Sets the process umask for the test and puts the old one back afterwards. */
function umaskZero(t) {
  const saved = process.umask(0);
  t.after(() => process.umask(saved));
}

test('the state folder is created 0700 under umask 0', { skip: !POSIX }, (t) => {
  isolateZnHome(t);
  umaskZero(t);
  const home = tempDir(t, 'zn-zc-state-mode-');
  writeConfig(home, { hooks: { enabled: false } });
  zc.install({ home, nodePath: '/usr/bin/node' });
  assert.ok(fs.existsSync(path.join(stateDir(home), 'zcode-hooks-enabled.json')));
  assert.equal(fs.statSync(stateDir(home)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, '.zn')).mode & 0o777, 0o700);
});

test('a state folder that already exists as 0777 is closed to 0700 on install', { skip: !POSIX }, (t) => {
  isolateZnHome(t);
  umaskZero(t);
  const home = tempDir(t, 'zn-zc-state-loose-');
  writeConfig(home, { hooks: { enabled: false } });
  fs.mkdirSync(stateDir(home), { recursive: true, mode: 0o777 });
  fs.chmodSync(stateDir(home), 0o777);
  assert.equal(fs.statSync(stateDir(home)).mode & 0o777, 0o777);
  zc.install({ home, nodePath: '/usr/bin/node' });
  assert.equal(fs.statSync(stateDir(home)).mode & 0o777, 0o700);
  assert.ok(fs.existsSync(path.join(stateDir(home), 'zcode-hooks-enabled.json')));
});
