'use strict';

process.env.ZN_STATS = 'off';

// zn-gate init --wrap-mcp with a config it cannot change: a plain reason about that config (no raw error code, no
// temporary file name), the next step, and exit code 1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('init --wrap-mcp: a config that cannot be written gets a plain reason, the next step and exit 1', { skip: process.platform === 'win32' || isRoot }, (t) => {
  const home = tempDir(t, 'zn-wrap-err-');
  const file = path.join(home, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { files: { command: 'node', args: ['server.js'] } } }) + '\n');
  fs.chmodSync(home, 0o500);
  let r;
  try {
    r = spawnSync(process.execPath, [CLI, 'init', '--wrap-mcp'], {
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), ZN_STATS: 'off' },
      input: '', encoding: 'utf8', timeout: 30000,
    });
  } finally { fs.chmodSync(home, 0o700); }
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = r.stdout + r.stderr;
  assert.ok(out.includes('zn could not change ' + file + ': your account is not allowed to change it or its folder. It was left as it was.'), out);
  assert.match(out, /run `zn-gate init --wrap-mcp` again/);
  assert.match(out, /1 could not be changed/);
  assert.doesNotMatch(out, /EACCES|zn-tmp|Error:/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.files.command, 'node', 'the config is unchanged');
});
