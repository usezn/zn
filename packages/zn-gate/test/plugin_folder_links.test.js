'use strict';

// A link below the plugins folder of Claude Code or ZCode that leaves that folder (into the project, a temp folder,
// anywhere an agent can write) makes the plugin untrusted: zn-gate check reports NOT protected and starts nothing
// through the link, and the policy still treats a write through the link as a write to the protected plugin folder.
// A link that stays inside the plugins folder keeps working.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('../lib/hooks/policy');
const { check: realCheck } = require('../lib/check');
const check = (opts) => realCheck({ nodeVersion: '22.0.0', ...opts });
const { tempDir } = require('./helpers/tmp');
const { pluginHooks, writePluginManifest } = require('./helpers/claude_plugin');

const posix = process.platform !== 'win32';
const SKIP = posix ? false : 'needs POSIX symbolic links and /bin/sh';
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const REPO_ZCODE_HOOKS = path.join(__dirname, '..', '..', '..', 'plugins', 'zcode', 'hooks', 'hooks.json');
const byId = (res, id) => res.results.find((r) => r.id === id);

function launcher(marker) {
  return "require('fs').appendFileSync(" + JSON.stringify(marker) + ", 'ran\\n');\n" +
    "const [mode] = process.argv.slice(2);\nif (mode === 'check') process.exit(0);\n" +
    "const r = require('child_process').spawnSync(process.execPath, [" + JSON.stringify(RUNNER) + ", 'claude-code'], { input: require('fs').readFileSync(0), encoding: 'utf8' });\n" +
    "process.stdout.write(r.stdout || ''); process.exit(r.status || 0);\n";
}

// A Claude Code plugin folder at `root` with a launcher that leaves a mark when it runs, listed in installed_plugins.json.
function claudePlugin(home, root, marker) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'zn-launch.js'), launcher(marker));
  writePluginManifest(root, pluginHooks());
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'zn-gate@usezn': [{ scope: 'user', installPath: root }] } }));
}

async function claudeCheck(t, home, env = {}) {
  return byId(await check({ home, env: { HOME: home, PATH: process.env.PATH, ...env }, cwd: tempDir(t, 'zn-pfl-cwd-'), live: true }), 'claude-code');
}

test('Claude Code plugin reached through a link that leaves the plugins folder is NOT protected and runs nothing', { skip: SKIP }, async (t) => {
  for (const where of ['project', 'tmp']) {
    const home = tempDir(t, 'zn-pfl-home-');
    const outside = tempDir(t, 'zn-pfl-' + where + '-');
    const marker = path.join(outside, 'ran.txt');
    const link = path.join(home, '.claude', 'plugins', 'cache', 'usezn');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link);
    claudePlugin(home, path.join(link, 'zn-gate'), marker);
    const r = await claudeCheck(t, home);
    assert.equal(r.state, 'not-protected', where);
    assert.match(r.problem, /reached through a link .* outside the folder where plugins are installed/, where);
    assert.ok(r.fix && r.fix.length > 0);
    assert.equal(fs.existsSync(marker), false, 'zn-gate check ran the plugin through a link (' + where + ')');
  }
});

test('Claude Code plugin whose hooks.json or hooks folder is a link out of the plugin is NOT protected and runs nothing', { skip: SKIP }, async (t) => {
  for (const kind of ['file', 'dir']) {
    const home = tempDir(t, 'zn-pfl-home-');
    const outside = tempDir(t, 'zn-pfl-out-');
    const marker = path.join(outside, 'ran.txt');
    const root = path.join(home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate', '1.0.0');
    claudePlugin(home, root, marker);
    // The same valid manifest, held in a folder the agent can write.
    fs.mkdirSync(path.join(outside, 'hooks'), { recursive: true });
    fs.copyFileSync(path.join(root, 'hooks', 'hooks.json'), path.join(outside, 'hooks', 'hooks.json'));
    if (kind === 'file') {
      fs.rmSync(path.join(root, 'hooks', 'hooks.json'));
      fs.symlinkSync(path.join(outside, 'hooks', 'hooks.json'), path.join(root, 'hooks', 'hooks.json'));
    } else {
      fs.rmSync(path.join(root, 'hooks'), { recursive: true });
      fs.symlinkSync(path.join(outside, 'hooks'), path.join(root, 'hooks'));
    }
    const r = await claudeCheck(t, home);
    assert.equal(r.state, 'not-protected', kind);
    assert.match(r.problem, /is a link that leads to/, kind);
    assert.equal(fs.existsSync(marker), false, 'zn-gate check ran the plugin whose hooks ' + kind + ' is a link');
  }
});

test('Claude Code plugin: a link that stays inside the plugins folder, and a plugin cache folder that is a real folder, keep working', { skip: SKIP }, async (t) => {
  const home = tempDir(t, 'zn-pfl-home-');
  const marker = path.join(tempDir(t, 'zn-pfl-mark-'), 'ran.txt');
  const real = path.join(home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate', '1.0.0');
  claudePlugin(home, real, marker);
  const alias = path.join(home, '.claude', 'plugins', 'cache', 'current');
  fs.symlinkSync(real, alias);
  claudePlugin(home, alias, marker);
  let r = await claudeCheck(t, home);
  assert.equal(r.state, 'protected', r.problem);
  // CLAUDE_CODE_PLUGIN_CACHE_DIR pointing at a real folder outside the project.
  const cache = tempDir(t, 'zn-pfl-cache-');
  claudePlugin(home, path.join(cache, 'zn-gate'), marker);
  r = await claudeCheck(t, home, { CLAUDE_CODE_PLUGIN_CACHE_DIR: cache });
  assert.equal(r.state, 'protected', r.problem);
});

// ZCode.
const ZID = 'zn-gate@usezn';
function zcodePlugin(home, root, marker) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.zcode-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zcode-plugin', 'plugin.json'), '{"name":"zn-gate","version":"1.14.0"}');
  fs.copyFileSync(REPO_ZCODE_HOOKS, path.join(root, 'hooks', 'hooks.json'));
  const deny = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"zn: .env holds plain-text secrets."}}';
  fs.writeFileSync(path.join(root, 'scripts', 'zn-hook.sh'),
    '#!/bin/sh\necho ran >> ' + JSON.stringify(marker) + '\ninput=$(cat)\ncase "$input" in *.env*) printf \'%s\' \'' + deny + '\' ;; esac\nexit 0\n', { mode: 0o755 });
  const base = path.join(home, '.zcode', 'cli');
  fs.mkdirSync(path.join(base, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(base, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 1, plugins: [{ id: ZID, name: 'zn-gate', marketplace: 'usezn', version: '1.14.0', installPath: root, scope: 'user', source: './zn-gate' }] }));
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ plugins: { enabledPlugins: { [ZID]: true } } }));
}
const zcodeCheck = async (t, home) => byId(await realCheck({ home, cwd: tempDir(t, 'zn-pfl-cwd-'), env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin' }, live: true }), 'zcode');

test('ZCode plugin reached through a link that leaves its plugins folder, or with a hooks.json that is one, is NOT protected and runs nothing', { skip: SKIP }, async (t) => {
  for (const kind of ['root', 'file']) {
    const home = tempDir(t, 'zn-pfl-zhome-');
    const outside = tempDir(t, 'zn-pfl-zout-');
    const marker = path.join(outside, 'ran.txt');
    if (kind === 'root') {
      const link = path.join(home, '.zcode', 'cli', 'plugins', 'cache');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(outside, link);
      zcodePlugin(home, path.join(link, 'zn-gate'), marker);
    } else {
      const root = path.join(home, '.zcode', 'cli', 'plugins', 'cache', 'usezn', 'zn-gate', '1.14.0');
      zcodePlugin(home, root, marker);
      fs.copyFileSync(path.join(root, 'hooks', 'hooks.json'), path.join(outside, 'hooks.json'));
      fs.rmSync(path.join(root, 'hooks', 'hooks.json'));
      fs.symlinkSync(path.join(outside, 'hooks.json'), path.join(root, 'hooks', 'hooks.json'));
    }
    const r = await zcodeCheck(t, home);
    assert.equal(r.state, 'not-protected', kind);
    assert.match(r.problem, /link/, kind);
    assert.equal(fs.existsSync(marker), false, 'zn-gate check ran the ZCode plugin through a link (' + kind + ')');
  }
});

test('ZCode plugin: a real folder in the plugins folder and a link that stays inside it are protected', { skip: SKIP }, async (t) => {
  const home = tempDir(t, 'zn-pfl-zhome-');
  const marker = path.join(tempDir(t, 'zn-pfl-zmark-'), 'ran.txt');
  const real = path.join(home, '.zcode', 'cli', 'plugins', 'cache', 'usezn', 'zn-gate', '1.14.0');
  zcodePlugin(home, real, marker);
  let r = await zcodeCheck(t, home);
  assert.equal(r.state, 'protected', r.problem);
  const alias = path.join(home, '.zcode', 'cli', 'plugins', 'cache', 'current');
  fs.symlinkSync(real, alias);
  zcodePlugin(home, alias, marker);
  r = await zcodeCheck(t, home);
  assert.equal(r.state, 'protected', r.problem);
});

test('policy: a write through a link below a plugins folder is a write to the protected plugin folder', { skip: SKIP }, (t) => {
  const home = tempDir(t, 'zn-pfl-phome-');
  const proj = tempDir(t, 'zn-pfl-pproj-');
  const cacheDir = tempDir(t, 'zn-pfl-pcache-');
  const target = tempDir(t, 'zn-pfl-ptarget-');
  for (const [dir, env] of [
    [path.join(home, '.claude', 'plugins', 'cache'), {}],
    [path.join(home, '.zcode', 'cli', 'plugins', 'cache'), {}],
    [path.join(home, 'cfg', 'plugins', 'cache'), { CLAUDE_CONFIG_DIR: path.join(home, 'cfg') }],
    [cacheDir, { CLAUDE_CODE_PLUGIN_CACHE_DIR: cacheDir }],
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const aim of [path.join(proj, 'x'), target]) {
      fs.mkdirSync(aim, { recursive: true });
      const link = path.join(dir, 'zn-' + path.basename(aim));
      fs.symlinkSync(aim, link);
      for (const p of [path.join(link, 'hooks', 'hooks.json'), path.join(link, 'new.json'), link]) {
        const c = policy.classifyPath(p, { home, cwd: proj, env });
        assert.equal(c && c.kind, 'agent_config', p);
      }
    }
  }
});

test('Claude Code plugin: a chain of links that goes out to a writable folder and comes back into the plugins folder is NOT protected', { skip: SKIP }, async (t) => {
  for (const kind of ['root', 'file']) {
    const home = tempDir(t, 'zn-pfl-home-');
    const hopDir = tempDir(t, 'zn-pfl-hop-');
    const marker = path.join(hopDir, 'ran.txt');
    const store = path.join(home, '.claude', 'plugins', 'store', 'zn-gate');
    claudePlugin(home, store, marker);
    if (kind === 'root') {
      const hop = path.join(hopDir, 'hop');
      fs.symlinkSync(store, hop);
      const link = path.join(home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(hop, link);
      claudePlugin(home, link, marker);
    } else {
      fs.copyFileSync(path.join(store, 'hooks', 'hooks.json'), path.join(store, 'hooks', 'real.json'));
      fs.rmSync(path.join(store, 'hooks', 'hooks.json'));
      const hop = path.join(hopDir, 'h');
      fs.symlinkSync(path.join(store, 'hooks', 'real.json'), hop);
      fs.symlinkSync(hop, path.join(store, 'hooks', 'hooks.json'));
    }
    const r = await claudeCheck(t, home);
    assert.equal(r.state, 'not-protected', kind);
    assert.match(r.problem, /link/, kind);
    assert.equal(fs.existsSync(marker), false, 'zn-gate check ran the plugin through a chain of links (' + kind + ')');
  }
});

test('Claude Code plugin whose lock file, node_modules or any other part is a link out of the plugin is NOT protected; links inside it are fine', { skip: SKIP }, async (t) => {
  const outside = tempDir(t, 'zn-pfl-out-');
  for (const kind of ['lock', 'node_modules', 'deep', 'inside']) {
    const home = tempDir(t, 'zn-pfl-home-');
    const marker = path.join(outside, 'ran-' + kind + '.txt');
    const root = path.join(home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate', '1.0.0');
    claudePlugin(home, root, marker);
    if (kind === 'lock') {
      fs.writeFileSync(path.join(outside, 'lock.json'), '{}');
      fs.symlinkSync(path.join(outside, 'lock.json'), path.join(root, 'scripts', 'zn-gate.lock.json'));
    } else if (kind === 'node_modules') {
      fs.mkdirSync(path.join(outside, 'nm'), { recursive: true });
      fs.symlinkSync(path.join(outside, 'nm'), path.join(root, 'node_modules'));
    } else if (kind === 'deep') {
      fs.mkdirSync(path.join(root, 'skills', 'a'), { recursive: true });
      fs.symlinkSync(outside, path.join(root, 'skills', 'a', 'x'));
    } else {
      fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
      fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'cli.js'), '');
      fs.symlinkSync('../pkg/cli.js', path.join(root, 'node_modules', '.bin', 'pkg'));
    }
    const r = await claudeCheck(t, home);
    if (kind === 'inside') {
      assert.equal(r.state, 'protected', r.problem);
    } else {
      assert.equal(r.state, 'not-protected', kind);
      assert.match(r.problem, /link/, kind);
      assert.equal(fs.existsSync(marker), false, kind);
    }
  }
});

test('Claude Code plugin: a plugins folder kept elsewhere as a link (dotfiles), named by its real path, is protected', { skip: SKIP }, async (t) => {
  const home = tempDir(t, 'zn-pfl-home-');
  const dots = tempDir(t, 'zn-pfl-dots-');
  const marker = path.join(dots, 'ran.txt');
  fs.symlinkSync(path.join(dots, 'claude'), path.join(home, '.claude'));
  fs.mkdirSync(path.join(dots, 'claude', 'plugins'), { recursive: true });
  claudePlugin(home, path.join(dots, 'claude', 'plugins', 'cache', 'zn-gate'), marker);
  const r = await claudeCheck(t, home);
  assert.equal(r.state, 'protected', r.problem);
});

test('Claude Code plugin: a link whose target goes through another link and ".." (evil/../hop) is judged by where the file system leads', { skip: SKIP }, async (t) => {
  const home = tempDir(t, 'zn-pfl-home-');
  const out = tempDir(t, 'zn-pfl-dotdot-');
  const marker = path.join(out, 'ran.txt');
  const store = path.join(home, '.claude', 'plugins', 'store', 'zn-gate');
  claudePlugin(home, store, marker);
  // evil leads to out/x, so evil/.. is out; out/hop leads back to the plugin. Read as text, evil/../hop stays in cache.
  fs.mkdirSync(path.join(out, 'x'));
  fs.symlinkSync(store, path.join(out, 'hop'));
  const cache = path.join(home, '.claude', 'plugins', 'cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.symlinkSync(path.join(out, 'x'), path.join(cache, 'evil'));
  fs.symlinkSync('evil/../hop', path.join(cache, 'zn-gate'));
  claudePlugin(home, path.join(cache, 'zn-gate'), marker);
  const r = await claudeCheck(t, home);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /link/);
  assert.equal(fs.existsSync(marker), false, 'zn-gate check ran the plugin through evil/../hop');
});
