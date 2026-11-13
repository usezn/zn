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

test('uninstall: a launcher that another Claude Code profile in the home folder still names is kept', async (t) => {
  const m = machine(t);
  install(m, 'user');
  const file = launcher.launcherFile('claude-code', { home: m.home, env: m.env });
  if (!launcher.isOurLauncher(file)) return t.skip('no launcher script on this platform');
  // A second profile (another CLAUDE_CONFIG_DIR) whose hooks call the shared launcher.
  const other = path.join(m.home, '.claude-work');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: file + ' PreToolUse' }] }] } }));
  const c = io(m);
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out());
  assert.ok(fs.existsSync(file), 'the launcher stays while another profile names it');
  assert.match(c.out(), /launcher script kept/);
});

test('uninstall with CLAUDE_CONFIG_DIR set keeps the shared launcher: other profiles may use it', async (t) => {
  const m = machine(t);
  const profile = tempDir(t, 'zn-ulp-profile-');
  m.env = { ...m.env, CLAUDE_CONFIG_DIR: profile };
  install(m, 'user');
  const file = launcher.launcherFile('claude-code', { home: m.home, env: m.env });
  if (!launcher.isOurLauncher(file)) return t.skip('no launcher script on this platform');
  const c = io(m);
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out());
  assert.ok(fs.existsSync(file), 'the launcher stays');
  assert.match(c.out(), /launcher script kept \(other Claude Code profiles may still use it\)/);
});

// Fail closed: a profile or a folder zn cannot read is "cannot tell", never "does not use the launcher".
test('uninstall: a profile settings file that cannot be read keeps the launcher', async (t) => {
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return t.skip('needs an unreadable file (a root user reads any file)');
  const m = machine(t);
  install(m, 'user');
  const file = launcher.launcherFile('claude-code', { home: m.home, env: m.env });
  if (!launcher.isOurLauncher(file)) return t.skip('no launcher script on this platform');
  const other = path.join(m.home, '.claude-work');
  fs.mkdirSync(other, { recursive: true });
  const settings = path.join(other, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: file + ' PreToolUse' }] }] } }));
  fs.chmodSync(settings, 0o000);
  const c = io(m);
  try { assert.equal(await dispatch('uninstall', [], c.o), 0, c.out()); } finally { fs.chmodSync(settings, 0o600); }
  assert.ok(fs.existsSync(file), 'the launcher stays when a profile cannot be checked');
  assert.match(c.out(), /launcher script kept \(a hooks file could not be read\)/);
});

test('uninstall: a profile settings file that is a folder (read error other than missing) keeps the launcher', async (t) => {
  const m = machine(t);
  install(m, 'user');
  const file = launcher.launcherFile('claude-code', { home: m.home, env: m.env });
  if (!launcher.isOurLauncher(file)) return t.skip('no launcher script on this platform');
  fs.mkdirSync(path.join(m.home, '.claude-odd', 'settings.json'), { recursive: true });
  const c = io(m);
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out());
  assert.ok(fs.existsSync(file), 'EISDIR is "cannot tell", not "does not name it"');
  assert.match(c.out(), /launcher script kept \(a hooks file could not be read\)/);
});

test('uninstall: a home folder that cannot be listed keeps the launcher (read error injected)', async (t) => {
  // Injected: the read error is simulated on the home folder only, so the test holds for any user, root included.
  const m = machine(t);
  install(m, 'user');
  const file = launcher.launcherFile('claude-code', { home: m.home, env: m.env });
  if (!launcher.isOurLauncher(file)) return t.skip('no launcher script on this platform');
  const real = fs.readdirSync;
  let injected = 0;
  fs.readdirSync = function (p, ...rest) {
    if (path.resolve(String(p)) === path.resolve(m.home)) { injected++; const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
    return real.call(this, p, ...rest);
  };
  const c = io(m);
  let rc;
  try { rc = await dispatch('uninstall', [], c.o); } finally { fs.readdirSync = real; }
  assert.ok(injected > 0, 'the home folder listing was hit');
  assert.equal(rc, 0, c.out());
  assert.ok(fs.existsSync(file), 'the launcher stays when the profiles cannot be listed');
  assert.match(c.out(), /launcher script kept \(a Claude Code profile could not be checked\)/);
});

test('uninstall: a settings file that cannot be read keeps the launcher (read error injected)', async (t) => {
  const m = machine(t);
  install(m, 'user');
  const file = launcher.launcherFile('claude-code', { home: m.home, env: m.env });
  if (!launcher.isOurLauncher(file)) return t.skip('no launcher script on this platform');
  const other = path.join(m.home, '.claude-work');
  fs.mkdirSync(other, { recursive: true });
  const target = path.join(other, 'settings.json');
  fs.writeFileSync(target, '{}');
  const real = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (path.resolve(String(p)) === path.resolve(target)) { const e = new Error('EIO: i/o error'); e.code = 'EIO'; throw e; }
    return real.call(this, p, ...rest);
  };
  const c = io(m);
  let rc;
  try { rc = await dispatch('uninstall', [], c.o); } finally { fs.readFileSync = real; }
  assert.equal(rc, 0, c.out());
  assert.ok(fs.existsSync(file), 'the launcher stays');
  assert.match(c.out(), /launcher script kept \(a hooks file could not be read\)/);
});

// Only folders are Claude Code profiles: ~/.claude.json (a file Claude Code writes on almost every machine) and its
// backups must not make the launcher stay for good.
test('uninstall: ~/.claude.json and its backup (files) are not profiles; the launcher is removed', async (t) => {
  const m = machine(t);
  install(m, 'user');
  const file = launcher.launcherFile('claude-code', { home: m.home, env: m.env });
  if (!launcher.isOurLauncher(file)) return t.skip('no launcher script on this platform');
  fs.writeFileSync(path.join(m.home, '.claude.json'), '{}');
  fs.writeFileSync(path.join(m.home, '.claude.json.backup'), '{}');
  const c = io(m);
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out());
  assert.equal(fs.existsSync(file), false, 'the launcher is removed: ' + c.out());
  assert.doesNotMatch(c.out(), /launcher script kept/);
});

test('uninstall: a link to a profile folder that names the launcher keeps it', async (t) => {
  const m = machine(t);
  install(m, 'user');
  const file = launcher.launcherFile('claude-code', { home: m.home, env: m.env });
  if (!launcher.isOurLauncher(file)) return t.skip('no launcher script on this platform');
  const real = tempDir(t, 'zn-ulp-alt-');
  fs.writeFileSync(path.join(real, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: file + ' PreToolUse' }] }] } }));
  try { fs.symlinkSync(real, path.join(m.home, '.claude-alt'), 'dir'); } catch (e) { return t.skip('no symbolic links here: ' + e.code); }
  const c = io(m);
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out());
  assert.ok(fs.existsSync(file), 'the launcher stays while a linked profile names it');
  assert.match(c.out(), /launcher script kept/);
});

test('uninstall: a link to a profile folder that does not name the launcher lets it go', async (t) => {
  const m = machine(t);
  install(m, 'user');
  const file = launcher.launcherFile('claude-code', { home: m.home, env: m.env });
  if (!launcher.isOurLauncher(file)) return t.skip('no launcher script on this platform');
  const real = tempDir(t, 'zn-ulp-alt2-');
  fs.writeFileSync(path.join(real, 'settings.json'), '{}');
  try { fs.symlinkSync(real, path.join(m.home, '.claude-alt'), 'dir'); } catch (e) { return t.skip('no symbolic links here: ' + e.code); }
  const c = io(m);
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out());
  assert.equal(fs.existsSync(file), false, c.out());
});

test('uninstall: a link that cannot be followed keeps the launcher (cannot tell)', async (t) => {
  const m = machine(t);
  install(m, 'user');
  const file = launcher.launcherFile('claude-code', { home: m.home, env: m.env });
  if (!launcher.isOurLauncher(file)) return t.skip('no launcher script on this platform');
  try { fs.symlinkSync(path.join(m.home, 'does-not-exist'), path.join(m.home, '.claude-gone')); } catch (e) { return t.skip('no symbolic links here: ' + e.code); }
  const c = io(m);
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out());
  assert.ok(fs.existsSync(file), 'the launcher stays');
  assert.match(c.out(), /launcher script kept \(a Claude Code profile could not be checked\)/);
});
