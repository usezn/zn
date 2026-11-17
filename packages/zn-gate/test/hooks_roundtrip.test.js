'use strict';
/*
 * Install then uninstall, for each JSON agent config zn edits: the file is back as it was (one-line JSON, a pre-existing
 * "{}", an indented file), a file install created is removed, keys the user added later are kept, and only the newest
 * zn backups are kept. Every path is inside a temporary fake home.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const cfg = require('../lib/agents/config-file');

const AGENTS = {
  'claude-code': require('../lib/agents/claude-code'),
  cursor: require('../lib/agents/cursor'),
  copilot: require('../lib/agents/copilot'),
  codex: require('../lib/agents/codex'),
  gemini: require('../lib/agents/gemini'),
  antigravity: require('../lib/agents/antigravity'),
};

const FIXTURES = {
  'one line': '{"theme":"dark","model":"example-model"}',
  'empty object': '{}\n',
  'tab indent': '{\n\t"theme": "dark"\n}\n',
};

function optsFor(name, home) {
  const env = name === 'claude-code' ? { CLAUDE_CONFIG_DIR: path.join(home, '.claude') } : {};
  return {
    home,
    env,
    mcp: false,
    managedDir: path.join(home, 'no-managed-policy'),
    platform: 'linux',
    scope: 'user',
    nodePath: '/usr/bin/node',
    runnerPath: '/x/lib/hooks/runner.js',
  };
}

function fileOf(name, o) {
  const mod = AGENTS[name];
  return (mod.settingsFile || mod.hooksFile)(o);
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

for (const name of Object.keys(AGENTS)) {
  const mod = AGENTS[name];
  const skip = process.platform === 'win32' ? 'POSIX paths and shells' : false;

  test(name + ': install then uninstall gives the file back as it was (one line, {}, tab indent)', { skip }, (t) => {
    for (const [label, text] of Object.entries(FIXTURES)) {
      const home = tempDir(t, 'zn-rt-');
      const o = optsFor(name, home);
      const file = fileOf(name, o);
      write(file, text);
      mod.install(o);
      assert.notEqual(fs.readFileSync(file, 'utf8'), text, label + ': install changed the file');
      assert.equal(mod.uninstall(o).removed, 1, label);
      assert.equal(fs.readFileSync(file, 'utf8'), text, label + ': uninstall restores the original bytes');
    }
  });

  test(name + ': a config file install created is removed by uninstall', { skip }, (t) => {
    const home = tempDir(t, 'zn-rt-new-');
    const o = optsFor(name, home);
    const file = fileOf(name, o);
    mod.install(o);
    assert.equal(fs.existsSync(file), true);
    assert.equal(mod.uninstall(o).removed, 1);
    assert.equal(fs.existsSync(file), false, 'no "{}" or skeleton left behind');
  });

  test(name + ': keys the user added after install are kept and zn entries are removed', { skip }, (t) => {
    const home = tempDir(t, 'zn-rt-edit-');
    const o = optsFor(name, home);
    const file = fileOf(name, o);
    write(file, FIXTURES['one line']);
    mod.install(o);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.added = 'by the user';
    write(file, JSON.stringify(data, null, 2) + '\n');
    assert.equal(mod.uninstall(o).removed, 1);
    const left = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(left.added, 'by the user');
    assert.equal(left.theme, 'dark');
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /zn-hook-|runner\.js/);
  });

  test(name + ': only the newest zn backups are kept', { skip }, (t) => {
    const home = tempDir(t, 'zn-rt-bak-');
    const o = optsFor(name, home);
    const file = fileOf(name, o);
    write(file, FIXTURES['tab indent']);
    for (let i = 0; i < 5; i++) {
      mod.install(o);
      mod.uninstall(o);
    }
    const kept = cfg.backupsOf(file);
    assert.equal(kept.length, cfg.KEEP_BACKUPS);
    // The copy of the original is among the newest when it was taken in the same second as the others (no overwrite).
    assert.equal(fs.readFileSync(file, 'utf8'), FIXTURES['tab indent']);
  });
}

test('config-file: two backups in the same second keep both, and an absent file leaves a marker', (t) => {
  const home = tempDir(t, 'zn-rt-cfg-');
  const file = path.join(home, 'x', 'hooks.json');
  assert.equal(cfg.backup(file), null);
  write(file, '{"a":1}\n');
  const first = cfg.backup(file);
  const second = cfg.backup(file);
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(first, 'utf8'), '{"a":1}\n');
  assert.equal(fs.readFileSync(second, 'utf8'), '{"a":1}\n');
  const names = cfg.backupsOf(file);
  assert.equal(names.filter((b) => b.absent).length, 1, 'the marker for the absent file is kept');
});

/* ---- the original survives re-installs (upgrades) and older installs keep the old fallbacks ---- */

for (const name of Object.keys(AGENTS)) {
  const mod = AGENTS[name];
  const skip = process.platform === 'win32' ? 'POSIX paths and shells' : false;

  test(name + ': after 5 re-installs, uninstall still gives back the original bytes', { skip }, (t) => {
    const home = tempDir(t, 'zn-rt-re-');
    const o = optsFor(name, home);
    const file = fileOf(name, o);
    write(file, FIXTURES['tab indent']);
    for (let i = 0; i < 5; i++) mod.install(o);
    assert.equal(cfg.backupsOf(file).length, cfg.KEEP_BACKUPS, 'ordinary backups are still pruned');
    assert.equal(fs.readFileSync(file + '.bak-zn-original', 'utf8'), FIXTURES['tab indent'], 'the original is not pruned or overwritten');
    assert.equal(mod.uninstall(o).removed, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), FIXTURES['tab indent']);
    assert.equal(fs.existsSync(file + '.bak-zn-original'), false, 'uninstall removes the kept original');
  });

  test(name + ': after 5 re-installs, uninstall still deletes a file install created', { skip }, (t) => {
    const home = tempDir(t, 'zn-rt-re-new-');
    const o = optsFor(name, home);
    const file = fileOf(name, o);
    for (let i = 0; i < 5; i++) mod.install(o);
    assert.equal(fs.existsSync(file + '.bak-zn-original-absent'), true);
    assert.equal(mod.uninstall(o).removed, 1);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(file + '.bak-zn-original-absent'), false);
  });
}

test('antigravity: an install from an older version (no kept original) is deleted when nothing else is left', { skip: process.platform === 'win32' }, (t) => {
  const home = tempDir(t, 'zn-rt-old-agy-');
  const o = optsFor('antigravity', home);
  const file = fileOf('antigravity', o);
  AGENTS.antigravity.install(o);
  for (const b of fs.readdirSync(path.dirname(file))) if (b.includes('.bak-zn-')) fs.unlinkSync(path.join(path.dirname(file), b));
  assert.equal(AGENTS.antigravity.uninstall(o).removed, 1);
  assert.equal(fs.existsSync(file), false);
});

test('copilot: an install from an older version (no kept original) is deleted when only version, hooks and disableAllHooks are left', { skip: process.platform === 'win32' }, (t) => {
  const home = tempDir(t, 'zn-rt-old-cop-');
  const o = optsFor('copilot', home);
  const file = fileOf('copilot', o);
  AGENTS.copilot.install(o);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.disableAllHooks = false;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  for (const b of fs.readdirSync(path.dirname(file))) if (b.includes('.bak-zn-')) fs.unlinkSync(path.join(path.dirname(file), b));
  assert.equal(AGENTS.copilot.uninstall(o).removed, 1);
  assert.equal(fs.existsSync(file), false);
});

test('config-file: files that only share the backup prefix are never listed or pruned', (t) => {
  const home = tempDir(t, 'zn-rt-keep-');
  const file = path.join(home, 'settings.json');
  write(file, '{"a":1}\n');
  const theirs = ['settings.json.bak-zn-user-notes-1', 'settings.json.bak-zn-user-notes-2', 'settings.json.bak-zn-user-notes-3', 'settings.json.bak-zn-20200101T000000.keep', 'settings.json.bak-zn-notes'];
  for (const n of theirs) write(path.join(home, n), 'mine ' + n);
  for (let i = 0; i < 8; i++) cfg.backup(file);
  for (const n of theirs) assert.equal(fs.readFileSync(path.join(home, n), 'utf8'), 'mine ' + n, n + ' was touched');
  assert.equal(cfg.backupsOf(file).length, cfg.KEEP_BACKUPS);
  assert.ok(cfg.backupsOf(file).every((b) => /\.bak-zn-\d{8}T\d{6}(-\d+)?(-absent)?$/.test(b.path)));
});

test('config-file: a link planted at a backup name is never written through', { skip: process.platform === 'win32' && 'symbolic links need extra rights on Windows' }, (t) => {
  const home = tempDir(t, 'zn-rt-link-');
  const outside = tempDir(t, 'zn-rt-link-target-');
  const file = path.join(home, 'settings.json');
  write(file, '{"a":1}\n');
  const target = path.join(outside, 'victim.txt');
  // A dangling link at the original's name: copying through it would create the target.
  fs.symlinkSync(target, file + '.bak-zn-original');
  assert.throws(() => cfg.backup(file), /symbolic link/);
  assert.equal(fs.existsSync(target), false, 'nothing was written through the dangling link');
  assert.equal(fs.lstatSync(file + '.bak-zn-original').isSymbolicLink(), true);
  // A link to an existing file at the original's name: the target keeps its content.
  fs.unlinkSync(file + '.bak-zn-original');
  write(target, 'keep me');
  fs.symlinkSync(target, file + '.bak-zn-original');
  assert.throws(() => cfg.backup(file), /symbolic link/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep me');
  // A link at the absent marker's name, when the file does not exist: removed as a stale original, never followed.
  fs.unlinkSync(file + '.bak-zn-original');
  fs.unlinkSync(file);
  fs.symlinkSync(target, file + '.bak-zn-original-absent');
  assert.equal(cfg.backup(file), null);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep me');
  assert.equal(fs.lstatSync(file + '.bak-zn-original-absent').isFile(), true);
});

test('config-file: the exclusive write refuses any entry, a dangling link included, and a kept original that is a link is not read', { skip: process.platform === 'win32' && 'symbolic links need extra rights on Windows' }, (t) => {
  const home = tempDir(t, 'zn-rt-excl-');
  const outside = tempDir(t, 'zn-rt-excl-target-');
  const target = path.join(outside, 'victim.txt');
  const dest = path.join(home, 'x.bak-zn-20200101T000000');
  fs.symlinkSync(target, dest);
  assert.throws(() => cfg._internal.writeNewFile(dest, 'data'), /symbolic link/);
  assert.equal(fs.existsSync(target), false);
  // A new rotating backup is a private regular file.
  const file = path.join(home, 'settings.json');
  write(file, '{"b":2}\n');
  const b = cfg.backup(file, { original: false });
  assert.equal(fs.lstatSync(b).isFile(), true);
  assert.equal(fs.existsSync(target), false);
  assert.equal((fs.statSync(b).mode & 0o777).toString(8), '600');
  // A link at the original's name is not taken for the original on uninstall.
  write(target, '{}');
  fs.symlinkSync(target, file + '.bak-zn-original');
  assert.equal(cfg.backupsOf(file).some((x) => x.path === file + '.bak-zn-original'), false);
});
