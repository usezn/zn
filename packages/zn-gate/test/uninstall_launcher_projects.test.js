'use strict';

// zn-gate uninstall and the shared launcher script: one uninstall never leaves another project's hooks pointing
// at a script that is gone, and a hook that could not be removed keeps the launcher. Temporary folders only.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const launcher = require('../lib/agents/launcher');
const { dispatch } = require('../lib/broker/cli');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

function machine(t) {
  const home = tempDir(t, 'zn-ulp-home-');
  const cwd = tempDir(t, 'zn-ulp-cwd-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { home, cwd, env: { HOME: home, USERPROFILE: home, PATH: '' } };
}

function io(m, extra = {}) {
  let out = '';
  const o = {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: () => {} },
    stdin: { isTTY: true },
    env: m.env, home: m.home, cwd: m.cwd, human: true, claude: null, ancestry: () => null,
    envList: [],
    confirm: async () => true,
    ...extra,
  };
  return { o, out: () => out };
}

const install = (m, scope, dir) => getAdapter('claude-code').install({
  scope, projectDir: dir || m.cwd, home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false,
});

test('uninstall from one project: the other project keeps hooks that never name the launcher, which is removed', async (t) => {
  const m = machine(t);
  const other = tempDir(t, 'zn-ulp-other-');
  install(m, 'user');
  install(m, 'project', m.cwd);
  install(m, 'project', other);
  const file = launcher.launcherFile('claude-code', { home: m.home, env: m.env });
  if (!launcher.isOurLauncher(file)) return t.skip('no launcher script on this platform');
  const c = io(m);
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out());
  const otherSettings = path.join(other, '.claude', 'settings.json');
  const text = fs.readFileSync(otherSettings, 'utf8');
  assert.ok(text.includes('zn'), 'the other project keeps its hooks');
  // Whatever the other project names must still exist: a project hook never points at the deleted launcher.
  assert.equal(text.includes(path.basename(file)) && !fs.existsSync(file), false, 'no hook points at a deleted launcher');
});

test('uninstall: a launcher that this folder\'s hooks file still names is kept', async (t) => {
  const m = machine(t);
  install(m, 'user');
  const file = launcher.launcherFile('claude-code', { home: m.home, env: m.env });
  if (!launcher.isOurLauncher(file)) return t.skip('no launcher script on this platform');
  const projectFile = path.join(m.cwd, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  // A project file with a hook of someone else that calls the shared launcher by name (zn leaves it: not zn's own entry).
  fs.writeFileSync(projectFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: file + ' PreToolUse' }] }] } }));
  const c = io(m);
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out());
  assert.ok(fs.existsSync(file), 'the launcher stays while a hooks file names it');
  assert.match(c.out(), /launcher script kept/);
});

test('uninstall: a project hook that could not be removed keeps the launcher', async (t) => {
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return t.skip('needs a read-only folder');
  const m = machine(t);
  install(m, 'user');
  install(m, 'project', m.cwd);
  const file = launcher.launcherFile('claude-code', { home: m.home, env: m.env });
  if (!launcher.isOurLauncher(file)) return t.skip('no launcher script on this platform');
  const dir = path.join(m.cwd, '.claude');
  fs.chmodSync(dir, 0o555);
  const c = io(m);
  let rc;
  try { rc = await dispatch('uninstall', [], c.o); } finally { fs.chmodSync(dir, 0o755); }
  assert.notEqual(rc, 0, c.out());
  assert.match(c.out(), /could not remove the project hooks/);
  assert.ok(fs.existsSync(file), 'the launcher stays: a hook may still call it');
  assert.match(c.out(), /launcher script kept/);
});
