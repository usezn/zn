'use strict';

process.env.ZN_STATS = 'off';

// zn-gate check and the zn-gate plugins of Codex CLI and the Antigravity CLI.
// Codex (CLI 0.164.0): `codex plugin add zn-gate@usezn` copies the plugin to <codex home>/plugins/cache/usezn/zn-gate/<version>/
// and writes [plugins."zn-gate@usezn"] enabled = true in config.toml; its hooks run only once trusted in `/hooks`,
// which writes [hooks.state."<id>:hooks/hooks.json:<event>:<group>:<handler>"] trusted_hash.
// Antigravity (agy 1.4.7): `agy plugin install` copies the plugin to ~/.gemini/config/plugins/zn-gate/ and
// `agy plugin disable zn-gate` writes {"plugins": {"zn-gate": {"enabled": false}}} to ~/.gemini/config/config.json.
// These tests use stub plugin folders; the real plugins are exercised by the e2e runs of each plugin.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { getAdapter } = require('../lib/agents');
const check = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const posix = process.platform !== 'win32';
const codex = getAdapter('codex');
const agy = getAdapter('antigravity');
const ID = 'zn-gate@usezn';
const EVENTS = ['PreToolUse', 'PermissionRequest', 'PostToolUse'];
const snake = (e) => e.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/* ------------------------------ Codex ------------------------------ */

const cxDir = (home) => path.join(home, '.codex');
const cxConfig = (home) => path.join(cxDir(home), 'config.toml');

// A plugin folder as Codex leaves it in its cache. The stub hook denies a request that names ".env".
function cxPlugin(home, { script = true, manifest = true, events = EVENTS, version = '1.14.0', market = 'usezn' } = {}) {
  const root = path.join(cxDir(home), 'plugins', 'cache', market, 'zn-gate', version);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
  if (manifest) fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), '{"name":"zn-gate","version":"' + version + '"}');
  const hooks = {};
  for (const e of events) hooks[e] = [{ matcher: '.*', hooks: [{ type: 'command', command: 'sh "$PLUGIN_ROOT/scripts/zn-hook.sh" ' + e, timeout: 30 }] }];
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks }));
  if (script) {
    fs.writeFileSync(path.join(root, 'scripts', 'zn-hook.sh'),
      '#!/bin/sh\ninput=$(cat)\ncase "$input" in *.env*) printf \'%s\' \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"zn: .env holds plain-text secrets."}}\' ;; esac\nexit 0\n',
      { mode: 0o755 });
  }
  return root;
}

// config.toml as Codex writes it: the plugin table, and a trusted_hash for each hook in `trusted`.
function cxConfigWrite(home, { enabled = true, trusted = EVENTS, off = [], id = ID, extra = '' } = {}) {
  let t = 'model = "x"\n\n[plugins."' + id + '"]\nenabled = ' + enabled + '\n';
  for (const e of trusted) t += '\n[hooks.state."' + id + ':hooks/hooks.json:' + snake(e) + ':0:0"]\ntrusted_hash = "sha256:' + 'ab'.repeat(32) + '"\ntrusted_content_hash = "sha256:' + 'cd'.repeat(32) + '"\n' + (off.includes(e) ? 'enabled = false\n' : '');
  fs.mkdirSync(cxDir(home), { recursive: true });
  fs.writeFileSync(cxConfig(home), t + extra);
}

const cxFind = async (home, cwd, live = true) => (await check.check({ home, cwd, env: { ...process.env, HOME: home, CODEX_HOME: '' }, live })).results.find((r) => r.id === 'codex');

test('codex pluginState: absent, trusted, untrusted, switched off, disabled, not ours', (t) => {
  const none = tempDir(t, 'zn-cxp-none-');
  const empty = { root: null, id: null, version: null, enabled: false, listed: false, hooks: [], untrusted: [], off: [], file: cxConfig(none) };
  assert.deepEqual(codex.pluginState({ home: none, env: {} }), empty);

  const home = tempDir(t, 'zn-cxp-state-');
  const root = cxPlugin(home);
  // The folder alone, without the plugin's entry in config.toml, is not an installed plugin.
  assert.equal(codex.pluginState({ home, env: {} }).root, null);

  cxConfigWrite(home);
  let s = codex.pluginState({ home, env: {} });
  assert.equal(s.root, root);
  assert.equal(s.id, ID);
  assert.equal(s.version, '1.14.0');
  assert.equal(s.enabled, true);
  assert.deepEqual(s.untrusted, []);
  assert.deepEqual(s.off, []);
  assert.deepEqual(s.hooks.map((h) => h.event), EVENTS);

  cxConfigWrite(home, { trusted: ['PreToolUse'] });
  s = codex.pluginState({ home, env: {} });
  assert.deepEqual(s.untrusted, ['PermissionRequest', 'PostToolUse']);

  cxConfigWrite(home, { trusted: [] });
  assert.deepEqual(codex.pluginState({ home, env: {} }).untrusted, EVENTS);

  cxConfigWrite(home, { off: ['PreToolUse'] });
  assert.deepEqual(codex.pluginState({ home, env: {} }).off, ['PreToolUse']);

  cxConfigWrite(home, { enabled: false });
  s = codex.pluginState({ home, env: {} });
  assert.equal(s.enabled, false);
  assert.equal(s.listed, true);

  // A newer version folder wins over an older one.
  cxPlugin(home, { version: '1.15.0' });
  assert.equal(codex.pluginState({ home, env: {} }).version, '1.15.0');

  // CODEX_HOME moves everything.
  const moved = tempDir(t, 'zn-cxp-moved-');
  fs.cpSync(cxDir(home), path.join(moved, 'elsewhere'), { recursive: true });
  assert.notEqual(codex.pluginState({ home: none, env: { CODEX_HOME: path.join(moved, 'elsewhere') } }).root, null);

  // A plugin of another name, a zn-gate folder without our files, an unreadable config.toml: not ours.
  const other = tempDir(t, 'zn-cxp-other-');
  cxPlugin(other); cxConfigWrite(other, { id: 'other@usezn' });
  assert.equal(codex.pluginState({ home: other, env: {} }).root, null);
  const noScript = tempDir(t, 'zn-cxp-noscript-');
  cxPlugin(noScript, { script: false }); cxConfigWrite(noScript);
  assert.equal(codex.pluginState({ home: noScript, env: {} }).root, null);
  const noManifest = tempDir(t, 'zn-cxp-nomanifest-');
  cxPlugin(noManifest, { manifest: false }); cxConfigWrite(noManifest);
  assert.equal(codex.pluginState({ home: noManifest, env: {} }).root, null);
  const broken = tempDir(t, 'zn-cxp-broken-');
  cxPlugin(broken); fs.writeFileSync(cxConfig(broken), '[plugins."zn-gate@usezn"\nenabled = ');
  assert.equal(codex.pluginState({ home: broken, env: {} }).root, null);
});

test('zn-gate check: the zn-gate plugin in Codex, trusted, protects on its own', { skip: !posix }, async (t) => {
  const home = tempDir(t, 'zn-cxp-ok-');
  const cwd = tempDir(t, 'zn-cxp-ok-cwd-');
  cxPlugin(home); cxConfigWrite(home);
  const r = await cxFind(home, cwd);
  assert.equal(r.state, 'protected', r.problem);
  assert.equal(r.via, 'plugin');
  assert.equal(r.verified, true);
  assert.equal(r.where, 'the zn-gate plugin');
  assert.notEqual((await cxFind(home, cwd, false)).state, 'not-set-up');
});

test('zn-gate check: a Codex plugin whose hooks are not trusted yet is NOT protected', { skip: !posix }, async (t) => {
  const home = tempDir(t, 'zn-cxp-untrusted-');
  const cwd = tempDir(t, 'zn-cxp-untrusted-cwd-');
  cxPlugin(home); cxConfigWrite(home, { trusted: [] });
  let r = await cxFind(home, cwd);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /plugin is installed in Codex, but its hooks are not trusted yet/);
  assert.match(r.fix, /\/hooks/);
  assert.equal(r.verified, undefined);
  // Only the PreToolUse hook counts for the verdict; the others are a note.
  cxConfigWrite(home, { trusted: ['PreToolUse'] });
  r = await cxFind(home, cwd);
  assert.equal(r.state, 'protected', r.problem);
  assert.ok(r.notes.some((n) => /not trusted yet in Codex \(PermissionRequest, PostToolUse\)/.test(n)), JSON.stringify(r.notes));
  // With zn's own hooks next to an untrusted plugin, the hooks protect and the plugin is a note.
  cxConfigWrite(home, { trusted: [] });
  codex.install({ home, env: {}, nodePath: process.execPath });
  r = await cxFind(home, cwd);
  assert.equal(r.state, 'protected', r.problem);
  assert.ok(r.notes.some((n) => /installed in Codex, but its hooks are not trusted yet; the hooks of `zn hooks install codex` are what protect/.test(n)), JSON.stringify(r.notes));
});

test('zn-gate check: a Codex plugin that is turned off, or whose PreToolUse hook is switched off, is NOT protected', { skip: !posix }, async (t) => {
  const home = tempDir(t, 'zn-cxp-off-');
  const cwd = tempDir(t, 'zn-cxp-off-cwd-');
  cxPlugin(home); cxConfigWrite(home, { enabled: false });
  let r = await cxFind(home, cwd);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /plugin is turned off in Codex \("enabled" is false for "zn-gate@usezn" in .*config\.toml\), and the hooks of `zn hooks install codex` are not installed/);
  assert.match(r.fix, /codex plugin add zn-gate@usezn/);
  cxConfigWrite(home, { off: ['PreToolUse'] });
  r = await cxFind(home, cwd);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /PreToolUse hook of the zn-gate plugin is switched off in .*config\.toml \(\[hooks\.state\] enabled = false\)/);
  // The plugin without a PreToolUse hook checks nothing before a call.
  const old = tempDir(t, 'zn-cxp-nopre-');
  cxPlugin(old, { events: ['PostToolUse'] }); cxConfigWrite(old, { trusted: ['PostToolUse'] });
  r = await cxFind(old, cwd);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /has no PreToolUse hook/);
});

test('zn-gate check: Codex plugin and zn hooks both on is protected, with a note about the double install', { skip: !posix }, async (t) => {
  const home = tempDir(t, 'zn-cxp-both-');
  const cwd = tempDir(t, 'zn-cxp-both-cwd-');
  cxPlugin(home); cxConfigWrite(home);
  codex.install({ home, env: {}, nodePath: process.execPath });
  const r = await cxFind(home, cwd);
  assert.equal(r.state, 'protected', r.problem);
  assert.equal(r.via, 'plugin');
  assert.ok(r.notes.some((n) => /zn hooks install codex/.test(n) && /checked twice/.test(n) && /hooks uninstall codex/.test(n) && /codex plugin remove zn-gate@usezn/.test(n)), JSON.stringify(r.notes));
});

test('zn-gate check: Codex hooks alone are unchanged by a plugin that is not there', { skip: !posix }, async (t) => {
  const home = tempDir(t, 'zn-cxp-hk-');
  const cwd = tempDir(t, 'zn-cxp-hk-cwd-');
  codex.install({ home, env: {}, nodePath: process.execPath });
  const r = await cxFind(home, cwd);
  assert.equal(r.state, 'protected', r.problem);
  assert.equal(r.via, 'hooks');
  assert.equal(r.notes.filter((n) => /plugin/.test(n)).length, 0);
});

/* ---------------------------- Antigravity ---------------------------- */

const agyConf = (home) => path.join(home, '.gemini', 'config');

// A plugin folder as agy leaves it. The stub hook denies a request that names ".env".
function agyPlugin(home, { script = true, manifest = true, hookName = 'zn-gate', name = 'zn-gate' } = {}) {
  const root = path.join(agyConf(home), 'plugins', 'zn-gate');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  if (manifest) fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ name, description: 'x' }));
  fs.writeFileSync(path.join(root, 'hooks.json'), JSON.stringify({ [hookName]: { enabled: true, PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'sh scripts/zn-hook.sh', timeout: 15 }] }] } }));
  if (script) {
    fs.writeFileSync(path.join(root, 'scripts', 'zn-hook.sh'),
      '#!/bin/sh\ninput=$(cat)\ncase "$input" in *.env*) printf \'%s\' \'{"decision":"deny","reason":"zn: .env holds plain-text secrets."}\' ;; *) printf \'%s\' \'{"decision":"allow"}\' ;; esac\nexit 0\n',
      { mode: 0o755 });
  }
  return root;
}
const agyConfWrite = (home, obj) => {
  fs.mkdirSync(agyConf(home), { recursive: true });
  fs.writeFileSync(path.join(agyConf(home), 'config.json'), JSON.stringify(obj));
};
const agyFind = async (home, cwd, live = true) => (await check.check({ home, cwd, env: { ...process.env, HOME: home }, live })).results.find((r) => r.id === 'antigravity');

test('antigravity pluginState: absent, on, off, entry removed, not ours', (t) => {
  const none = tempDir(t, 'zn-agp-none-');
  assert.deepEqual(agy.pluginState({ home: none }), { root: null, id: null, version: null, enabled: false, listed: false, file: path.join(agyConf(none), 'config.json') });

  const home = tempDir(t, 'zn-agp-state-');
  const root = agyPlugin(home);
  let s = agy.pluginState({ home });
  assert.equal(s.root, root);
  assert.equal(s.id, 'zn-gate');
  assert.equal(s.enabled, true, 'no entry in config.json means on');

  agyConfWrite(home, { plugins: { 'zn-gate': { enabled: false } } });
  s = agy.pluginState({ home });
  assert.equal(s.enabled, false);
  assert.equal(s.listed, true);

  agyConfWrite(home, { plugins: { 'zn-gate': { enabled: true } } });
  assert.equal(agy.pluginState({ home }).enabled, true);
  agyConfWrite(home, { plugins: {} });
  assert.equal(agy.pluginState({ home }).enabled, true);
  fs.writeFileSync(path.join(agyConf(home), 'config.json'), '{ nope');
  assert.equal(agy.pluginState({ home }).enabled, true);

  const other = tempDir(t, 'zn-agp-other-');
  agyPlugin(other, { name: 'other' });
  assert.equal(agy.pluginState({ home: other }).root, null);
  const noScript = tempDir(t, 'zn-agp-noscript-');
  agyPlugin(noScript, { script: false });
  assert.equal(agy.pluginState({ home: noScript }).root, null);
  const noManifest = tempDir(t, 'zn-agp-nomanifest-');
  agyPlugin(noManifest, { manifest: false });
  assert.equal(agy.pluginState({ home: noManifest }).root, null);
  const foreignHook = tempDir(t, 'zn-agp-foreign-');
  agyPlugin(foreignHook, { hookName: 'something-else' });
  assert.equal(agy.pluginState({ home: foreignHook }).root, null);
});

test('zn-gate check: the zn-gate plugin in Antigravity protects on its own', { skip: !posix }, async (t) => {
  const home = tempDir(t, 'zn-agp-ok-');
  const cwd = tempDir(t, 'zn-agp-ok-cwd-');
  agyPlugin(home);
  for (const conf of [null, { plugins: { 'zn-gate': { enabled: true } } }]) {
    if (conf) agyConfWrite(home, conf);
    const r = await agyFind(home, cwd);
    assert.equal(r.state, 'protected', r.problem);
    assert.equal(r.via, 'plugin');
    assert.equal(r.verified, true);
    assert.equal(r.where, 'the zn-gate plugin');
  }
  assert.notEqual((await agyFind(home, cwd, false)).state, 'not-set-up');
});

test('zn-gate check: an Antigravity plugin that is turned off, with nothing else of zn running, is NOT protected', { skip: !posix }, async (t) => {
  const home = tempDir(t, 'zn-agp-off-');
  const cwd = tempDir(t, 'zn-agp-off-cwd-');
  agyPlugin(home); agyConfWrite(home, { plugins: { 'zn-gate': { enabled: false } } });
  const r = await agyFind(home, cwd);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /plugin is turned off in Antigravity \("enabled" is false for "zn-gate" in .*config\.json\), and the hooks of `zn hooks install antigravity` are not installed/);
  assert.match(r.fix, /agy plugin enable zn-gate/);
  assert.match(r.fix, /zn hooks install antigravity/);
});

test('zn-gate check: Antigravity plugin and zn hooks both on is protected, with a note about the double install', { skip: !posix }, async (t) => {
  const home = tempDir(t, 'zn-agp-both-');
  const cwd = tempDir(t, 'zn-agp-both-cwd-');
  agy.install({ scope: 'user', home, nodePath: process.execPath });
  agyPlugin(home);
  const r = await agyFind(home, cwd);
  assert.equal(r.state, 'protected', r.problem);
  assert.equal(r.via, 'plugin');
  assert.ok(r.notes.some((n) => /zn hooks install antigravity/.test(n) && /checked twice/.test(n) && /hooks uninstall antigravity/.test(n) && /agy plugin disable zn-gate/.test(n)), JSON.stringify(r.notes));
});

test('zn-gate check: Antigravity plugin off with zn hooks on is protected by the hooks', { skip: !posix }, async (t) => {
  const home = tempDir(t, 'zn-agp-hk-');
  const cwd = tempDir(t, 'zn-agp-hk-cwd-');
  agy.install({ scope: 'user', home, nodePath: process.execPath });
  agyPlugin(home); agyConfWrite(home, { plugins: { 'zn-gate': { enabled: false } } });
  const r = await agyFind(home, cwd);
  assert.equal(r.state, 'protected', r.problem);
  assert.equal(r.via, 'hooks');
  assert.ok(r.notes.some((n) => /installed in Antigravity but turned off; the hooks of `zn hooks install antigravity` are what protect/.test(n)), JSON.stringify(r.notes));
});

test('zn-gate check: Antigravity hooks alone are unchanged by a plugin that is not there', { skip: !posix }, async (t) => {
  const home = tempDir(t, 'zn-agp-none2-');
  const cwd = tempDir(t, 'zn-agp-none2-cwd-');
  agy.install({ scope: 'user', home, nodePath: process.execPath });
  const r = await agyFind(home, cwd);
  assert.equal(r.state, 'protected', r.problem);
  assert.equal(r.via, 'hooks');
  assert.equal(r.notes.filter((n) => /plugin/.test(n)).length, 0);
});
