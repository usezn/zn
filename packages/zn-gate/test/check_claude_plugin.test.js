'use strict';

// zn-gate check: how the Claude Code plugin is found in a Claude folder.
// Everything is made up in a temporary home; the real Claude folder is never read.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { _internal } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const { claudePlugin } = _internal;
const ID = 'zn-gate@usezn';

function setup(t) {
  const home = tempDir(t, 'zn-claude-plugin-');
  const env = { HOME: home, PATH: process.env.PATH };
  const plugins = path.join(home, '.claude', 'plugins');
  const list = (data) => {
    fs.mkdirSync(plugins, { recursive: true });
    fs.writeFileSync(path.join(plugins, 'installed_plugins.json'), typeof data === 'string' ? data : JSON.stringify(data));
  };
  const install = (name, withLauncher) => {
    const root = path.join(plugins, 'cache', name);
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    if (withLauncher) fs.writeFileSync(path.join(root, 'scripts', 'zn-launch.js'), '// launcher\n');
    return root;
  };
  const settings = (data) => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(data));
  };
  return { home, env, list, install, settings };
}

test('claudePlugin: no plugins folder means no plugin and not switched off', (t) => {
  const s = setup(t);
  const r = claudePlugin(s.home, s.env);
  assert.equal(r.root, null);
  assert.ok(!r.off);
});

test('claudePlugin: a listed plugin with scripts/zn-launch.js gives its install path', (t) => {
  const s = setup(t);
  const root = s.install('with', true);
  s.list({ version: 2, plugins: { [ID]: [{ scope: 'user', installPath: root }] } });
  const r = claudePlugin(s.home, s.env);
  assert.equal(r.root, root);
  assert.ok(!r.off);
});

test('claudePlugin: a listed plugin without scripts/zn-launch.js gives no root', (t) => {
  const s = setup(t);
  const root = s.install('without', false);
  s.list({ version: 2, plugins: { [ID]: [{ scope: 'user', installPath: root }] } });
  assert.equal(claudePlugin(s.home, s.env).root, null);
});

test('claudePlugin: a damaged installed_plugins.json gives no root and does not throw', (t) => {
  const s = setup(t);
  s.list('{ "plugins": ');
  const r = claudePlugin(s.home, s.env);
  assert.equal(r.root, null);
  assert.ok(!r.off);
});

test('claudePlugin: the plugin switched off in settings.json is reported as off', (t) => {
  const s = setup(t);
  const root = s.install('with', true);
  s.list({ version: 2, plugins: { [ID]: [{ scope: 'user', installPath: root }] } });
  s.settings({ enabledPlugins: { [ID]: false } });
  assert.deepEqual(claudePlugin(s.home, s.env), { root, off: true });
});
