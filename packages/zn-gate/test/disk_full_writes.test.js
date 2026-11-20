'use strict';

// Writes on a full disk: the command fails cleanly. It exits non-zero, names the file in a plain sentence, leaves no
// temporary file or 0-byte file behind, and keeps the file it was replacing unchanged. The disk is simulated by making
// fs.writeSync fail with ENOSPC: in a child process for the command-line tests (every file descriptor above stdio),
// and in place for the library tests (restored when each test ends).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { AGENT_ENV_VARS } = require('../lib/broker/tty');
const { tempDir } = require('./helpers/tmp');
const { writeFileAtomic } = require('../lib/atomic-file');
const store = require('../lib/vault/store');

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

function enospc() {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' });
}

function cleanEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), ZN_STATS: 'off' };
  delete env.ZN_HOME;
  delete env.ZN_VERBOSE;
  delete env.DEBUG;
  for (const v of AGENT_ENV_VARS) delete env[v];
  return env;
}

function setup(t, name) {
  const home = tempDir(t, name);
  const preload = path.join(home, 'enospc-preload.js');
  fs.writeFileSync(preload, PRELOAD);
  return { home, preload };
}

function run(home, args, preload, { fullDisk = true } = {}) {
  const nodeArgs = fullDisk ? ['-r', preload, CLI, ...args] : [CLI, ...args];
  const r = spawnSync(process.execPath, nodeArgs, { cwd: home, env: cleanEnv(home), encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// Names of entries in dir that look like a temp file zn would leave: "*.tmp", "*.zn-tmp*", or any name with a ".<pid>." part.
function leftoverTemps(dir) {
  return fs.readdirSync(dir).filter((n) => /\.tmp$|zn-tmp|\.\d+\.[0-9a-f]+\./.test(n));
}

test('stats share off on a full disk: exits 1, names the config file, sharing stays on, no temp file is left', (t) => {
  const { home, preload } = setup(t, 'zn-stats-enospc-');
  const zn = path.join(home, '.zn');
  fs.mkdirSync(zn, { recursive: true, mode: 0o700 });
  const cfg = path.join(zn, 'config.json');
  const before = JSON.stringify({ stats: { share: true, install_id: '00000000-0000-4000-8000-000000000001', sent_until: '2026-11-01' } }, null, 2) + '\n';
  fs.writeFileSync(cfg, before);

  const r = run(home, ['stats', 'share', 'off'], preload);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /The disk that holds .*config\.json is full\. Free some space, then try again\./);
  assert.match(r.out, /Sharing is still on; the setting did not change\./);
  assert.doesNotMatch(r.out, /ENOSPC|no space left/);
  assert.equal(fs.readFileSync(cfg, 'utf8'), before, 'the config is unchanged');
  assert.deepEqual(leftoverTemps(zn), []);
});

test('audit --output on a full disk: exits non-zero, names the file, writes nothing and keeps an existing file', (t) => {
  const { home, preload } = setup(t, 'zn-audit-enospc-');
  const project = path.join(home, 'proj');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'README.md'), '# example\n');
  const out = path.join(home, 'audit.json');
  fs.writeFileSync(out, 'OLD REPORT\n');

  const r = run(home, ['audit', project, '--format', 'json', '--output', out], preload);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /The disk that holds .*audit\.json is full\. Free some space, then try again\./);
  assert.doesNotMatch(r.out, /ENOSPC|no space left/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'OLD REPORT\n', 'the existing report is intact');
  assert.deepEqual(leftoverTemps(home), []);
});

test('audit --output to a new file on a full disk: no 0-byte file is left behind', (t) => {
  const { home, preload } = setup(t, 'zn-audit-new-enospc-');
  const project = path.join(home, 'proj');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'README.md'), '# example\n');
  const out = path.join(home, 'audit-new.json');

  const r = run(home, ['audit', project, '--format', 'json', '--output', out], preload);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /The disk that holds .*audit-new\.json is full/);
  assert.equal(fs.existsSync(out), false, 'no file is created');
  assert.deepEqual(leftoverTemps(home), []);
});

test('writeFileAtomic on a full disk: the target keeps its content, no temp file is left, and the error names the target', (t) => {
  const dir = tempDir(t, 'zn-atomic-enospc-');
  const target = path.join(dir, 'config.json');
  fs.writeFileSync(target, 'OLD');
  const realWriteSync = fs.writeSync;
  fs.writeSync = () => { throw enospc(); };
  let err = null;
  try {
    writeFileAtomic(target, 'NEW CONTENT');
  } catch (e) {
    err = e;
  } finally {
    fs.writeSync = realWriteSync;
  }
  assert.ok(err, 'the write fails');
  assert.equal(err.code, 'ENOSPC');
  assert.equal(err.path, target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'OLD');
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('vault writePrivateFile on a full disk: the old file is kept, no temp file is left, the error names the vault file', (t) => {
  const dir = tempDir(t, 'zn-vault-enospc-');
  const file = path.join(dir, 'keychain.json');
  fs.writeFileSync(file, 'OLD');
  const realWriteSync = fs.writeSync;
  fs.writeSync = () => { throw enospc(); };
  let err = null;
  try {
    store.writePrivateFile(file, 'NEW');
  } catch (e) {
    err = e;
  } finally {
    fs.writeSync = realWriteSync;
  }
  assert.ok(err, 'the write fails');
  assert.equal(err.path, file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'OLD');
  assert.deepEqual(fs.readdirSync(dir), ['keychain.json']);
});

test('a full disk is one sentence for every command: a named file, or "the zn file" when no file is known', () => {
  const { fsErrorText } = require('../lib/errors');
  const full = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28 });
  assert.equal(fsErrorText(full, '/home/example-user/.zn/config.json', {}, 'linux'), 'The disk that holds /home/example-user/.zn/config.json is full. Free some space, then try again.');
  assert.equal(fsErrorText(full, null, {}, 'linux'), 'The disk that holds the zn file is full. Free some space, then try again.');
  assert.equal(fsErrorText(full, null, {}, 'win32'), 'The disk that holds the zn file is full. Free some space, then try again.');
});
