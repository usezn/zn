'use strict';
// zn status in an empty home exits 0 and prints no stack trace, with ZN_HOME
// unset and with ZN_HOME pointing inside that empty home. Values are fake.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function emptyHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zn-status-empty-'));
}

function runStatus(home, znHome) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_LOCAL_ONLY: 'true' };
  delete env.ZN_HOME;
  delete env.NO_COLOR;
  delete env.ZN_API_KEY;
  if (znHome !== undefined) env.ZN_HOME = znHome;
  return spawnSync(process.execPath, [CLI, 'status'], { encoding: 'utf8', env, timeout: 60000 });
}

function assertNoStackTrace(r) {
  assert.strictEqual(r.status, 0, 'exit code ' + r.status + ': ' + r.stderr);
  const all = (r.stdout || '') + (r.stderr || '');
  assert.ok(!/^\s+at /m.test(all), 'stack frame in output: ' + all.slice(0, 300));
  assert.ok(!/Error:/.test(all), 'Error: in output: ' + all.slice(0, 300));
}

test('status in an empty home with ZN_HOME unset exits 0 and prints no stack trace', () => {
  const home = emptyHome();
  try {
    assertNoStackTrace(runStatus(home, undefined));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('status in an empty home with ZN_HOME inside it exits 0 and prints no stack trace', () => {
  const home = emptyHome();
  try {
    const znHome = path.join(home, '.zn-state');
    assertNoStackTrace(runStatus(home, znHome));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
