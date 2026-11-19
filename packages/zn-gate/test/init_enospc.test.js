'use strict';

// zn-gate init --wrap-mcp and --revert on a full disk: the command exits 1, says which file it could not change,
// leaves the config as it was and leaves no temporary file behind. A normal run is not changed by the fix.
// The disk is simulated in a child process: fs.writeSync fails with ENOSPC for every file descriptor above stdio.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { AGENT_ENV_VARS } = require('../lib/broker/tty');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

const PRELOAD = `
'use strict';
const fs = require('fs');
const realWriteSync = fs.writeSync;
fs.writeSync = function (fd, ...rest) {
  if (fd > 2) {
    const e = new Error('ENOSPC: no space left on device, write');
    e.code = 'ENOSPC';
    e.errno = -28;
    e.syscall = 'write';
    throw e;
  }
  return realWriteSync.call(fs, fd, ...rest);
};
`;

const ORIGINAL = JSON.stringify({ mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } } }, null, 2) + '\n';

function cleanEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), ZN_STATS: 'off' };
  for (const v of AGENT_ENV_VARS) delete env[v];
  delete env.ZN_VERBOSE;
  delete env.DEBUG;
  return env;
}

function setup(t) {
  const home = tempDir(t, 'zn-init-enospc-');
  const preload = path.join(home, 'enospc-preload.js');
  fs.writeFileSync(preload, PRELOAD);
  fs.writeFileSync(path.join(home, '.claude.json'), ORIGINAL);
  return { home, preload };
}

function run(home, args, { fullDisk = false, preload } = {}) {
  const nodeArgs = fullDisk ? ['-r', preload, CLI, ...args] : [CLI, ...args];
  const r = spawnSync(process.execPath, nodeArgs, { cwd: home, env: cleanEnv(home), encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// Every file under home, with its size, so a leftover temp file or a 0-byte file shows up.
function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(dir, full) + ':' + fs.statSync(full).size);
    }
  })(dir);
  return out.sort();
}

function assertNoTempFiles(home) {
  const leftovers = listFiles(home).filter((f) => f.includes('zn-tmp'));
  assert.deepEqual(leftovers, [], 'no temporary file may be left behind');
}

test('zn-gate init --wrap-mcp on a full disk: exit 1, plain message with the path, config intact, no temp file', (t) => {
  const { home, preload } = setup(t);
  const before = listFiles(home);

  const r = run(home, ['init', '--wrap-mcp'], { fullDisk: true, preload });

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /The disk that holds .*\.claude\.json\.bak\.\d+ is full\. Free some space, then try again\./);
  assert.doesNotMatch(r.out, /ENOSPC|no space left/);
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), ORIGINAL);
  assert.deepEqual(listFiles(home), before, 'nothing new may be created');
  assertNoTempFiles(home);
});

test('zn-gate init --revert on a full disk: exit 1, plain message with the path, wrapped config kept, no temp file', (t) => {
  const { home, preload } = setup(t);

  const wrapped = run(home, ['init', '--wrap-mcp']);
  assert.equal(wrapped.status, 0, wrapped.out);
  const wrappedText = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
  assert.match(wrappedText, /shield/);
  const before = listFiles(home);

  const r = run(home, ['init', '--revert'], { fullDisk: true, preload });

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /The disk that holds .*\.claude\.json is full\. Free some space, then try again\./);
  assert.doesNotMatch(r.out, /ENOSPC|no space left/);
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), wrappedText);
  assert.deepEqual(listFiles(home), before, 'nothing new may be created');
  assertNoTempFiles(home);
});

test('zn-gate init --wrap-mcp and --revert on a normal disk: exit 0, wrap then restore the original config', (t) => {
  const { home } = setup(t);

  const wrap = run(home, ['init', '--wrap-mcp']);
  assert.equal(wrap.status, 0, wrap.out);
  assert.match(wrap.out, /\[shielded\]/);
  assert.match(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), /shield/);
  assertNoTempFiles(home);

  const revert = run(home, ['init', '--revert']);
  assert.equal(revert.status, 0, revert.out);
  assert.match(revert.out, /\[reverted\]/);
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), ORIGINAL);
  assertNoTempFiles(home);
});

test('zn-gate init --wrap-mcp with nothing to wrap: exit 0 and no file is changed', (t) => {
  const home = tempDir(t, 'zn-init-enospc-empty-');
  const r = run(home, ['init', '--wrap-mcp']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(listFiles(home), []);
});
