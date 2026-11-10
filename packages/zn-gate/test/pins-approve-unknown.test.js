'use strict';
// `zn-gate pins approve <unknown server>` in a plain pipe (no terminal): it exits 2 with one clear line
// and approves nothing. A pipe is refused before the server is looked up, so the line is the
// no-terminal refusal, not "no server <key>".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const CLI = path.join(pkgRoot, 'bin', 'cli.js');
const messages = require(path.join(pkgRoot, 'lib', 'messages'));

test('pins approve <unknown server> piped (no terminal) exits 2 with the no-terminal line', () => {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-b5069-'));
  try {
    const unknown = '0123456789abcdef';
    const r = spawnSync(process.execPath, [CLI, 'pins', 'approve', unknown], {
      encoding: 'utf8',
      input: unknown + '\n',
      timeout: 30000,
      env: {
        PATH: process.env.PATH || '',
        HOME: home,
        USERPROFILE: home,
        ZN_HOME: path.join(home, '.zn'),
        TMPDIR: home,
        NO_COLOR: '1',
        ZN_STATS: 'off',
        ZN_LOCAL_ONLY: 'true',
      },
    });
    assert.strictEqual(r.status, 2, r.stderr);
    assert.strictEqual(r.stderr.trim(), messages.PINS_NEEDS_TERMINAL);
    assert.ok(!r.stdout.includes(unknown) && !r.stderr.includes('no server'), 'the unknown key is not looked up');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
