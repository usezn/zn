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
