'use strict';
// zn-gate status prints the same text with NO_COLOR set and unset, once ANSI
// escape codes are stripped. The home directory is a temporary directory.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function status(home, noColor) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: home, ZN_LOCAL_ONLY: 'true' };
  delete env.NO_COLOR;
  delete env.ZN_API_KEY;
  if (noColor !== undefined) env.NO_COLOR = noColor;
  const r = spawnSync(process.execPath, [CLI, 'status'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.replace(ANSI, '');
}

test('status in an empty home: same text with NO_COLOR set and unset, after stripping ANSI codes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-status-'));
  try {
    const withColorOff = status(home, '1');
    const withColorOn = status(home, undefined);
    assert.ok(withColorOff.length > 0, 'no output');
    assert.strictEqual(withColorOff, withColorOn);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
