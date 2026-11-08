'use strict';

// `zn-gate status` with no config and no agent on PATH: it exits 0 and prints its fixed rows.
// Status prints one fixed set of rows, not a line per installed agent, so the per-agent part
// is a todo until the product decides what status should list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function runStatus(t, home) {
  // PATH holds only the node binary, so no agent CLI is found on this machine.
  const env = {
    PATH: path.dirname(process.execPath),
    HOME: home,
    USERPROFILE: home,
    ZN_HOME: path.join(home, '.zn'),
    NO_COLOR: '1',
  };
  return spawnSync(process.execPath, [CLI, 'status'], { env, encoding: 'utf8', timeout: 30000 });
}

test('status with no config exits 0 and prints the fixed rows', (t) => {
  const home = tempDir(t, 'zn-status-empty-');
  const r = runStatus(t, home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\s*Package Version\s*: /m);
  assert.match(r.stdout, /^\s*Active Engine\s*: Local rules only$/m);
  assert.match(r.stdout, /^\s*Leaves machine\s*: Nothing$/m);
});

test('status with no config prints no agent row when no agent is installed',
  (t) => {
    const home = tempDir(t, 'zn-status-noagent-');
    const r = runStatus(t, home);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /^\s*(Claude Code|Codex CLI|Cursor)\s*:/m);
  });

test('status names each installed agent (not implemented: status prints fixed rows)',
  { todo: 'status prints fixed rows only; it has no per-agent line for an installed agent' },
  (t) => {
    const home = tempDir(t, 'zn-status-claude-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const r = runStatus(t, home);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Claude Code/);
  });
