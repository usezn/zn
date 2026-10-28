'use strict';

// Path classification (normalisation, globs, substitution), protection of the
// agents' hook configuration, and the adapter changes that go with them.
// Values are fake (fixtures generator). Nothing here touches the real home.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const policy = require('../lib/hooks/policy');
const runner = require('../lib/hooks/runner');
const cfg = require('../lib/agents/config-file');
const { getAdapter } = require('../lib/agents');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { generateAll } = require('./fixtures/fake_secrets');
const { tempDir } = require('./helpers/tmp');

const FAKE = generateAll(6161, { perType: 1, piiPerType: 1 });
const AWS = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const WIN = process.platform === 'win32';

function tmpHome(t) {
  const home = tempDir(t, 'zn-paths-');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  return { home, proj };
}

function run(adapter, raw, extra = {}) {
  return runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'zn run --', ...extra });
}

const codex = getAdapter('codex');
const cursor = getAdapter('cursor');
const opencode = getAdapter('opencode');

/* ---------------------------- path normalisation ---------------------------- */

test('credential paths are found through ~, $HOME, ${HOME}, %USERPROFILE% and $env:USERPROFILE', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: {} };
  for (const p of ['~/.aws/credentials', '$HOME/.aws/credentials', '${HOME}/.aws/credentials',
    '%USERPROFILE%/.aws/credentials', '$env:USERPROFILE/.aws/credentials']) {
    assert.equal(policy.classifyPath(p, opts).kind, 'credential', p);
  }
});

test('a link inside the project to a credential file is the credential file', { skip: WIN }, (t) => {
  const { home, proj } = tmpHome(t);
  fs.mkdirSync(path.join(home, '.aws'));
  fs.writeFileSync(path.join(home, '.aws', 'credentials'), 'x\n');
  fs.symlinkSync(path.join(home, '.aws', 'credentials'), path.join(proj, 'notes.txt'));
  assert.equal(policy.classifyPath('notes.txt', { home, cwd: proj, env: {} }).kind, 'credential');
});

test('case is ignored on Windows and macOS, and kept on Linux', (t) => {
  const { home, proj } = tmpHome(t);
  const upper = path.join(home, '.AWS', 'CREDENTIALS');
  const c = policy.classifyPath(upper, { home, cwd: proj, env: {} });
  assert.equal(c ? c.kind : null, CASE_INSENSITIVE ? 'credential' : null);
});

test('credential environment variables name credential paths, set or not', (t) => {
  const { home, proj } = tmpHome(t);
  const kube = path.join(home, 'kube', 'cluster.yaml');
  const opts = { home, cwd: proj, env: {} };
  // Not set here: the variable itself is enough.
  assert.equal(policy.classifyPath('$KUBECONFIG', opts).kind, 'credential');
  assert.equal(policy.classifyPath('${AZURE_CONFIG_DIR}/token.json', opts).kind, 'credential');
  // Set: its value is a credential file, and so is a path equal to it.
  const env = { KUBECONFIG: kube, AZURE_CONFIG_DIR: path.join(home, 'azure') };
  assert.equal(policy.classifyPath(kube, { home, cwd: proj, env }).kind, 'credential');
  assert.equal(policy.classifyPath(path.join(home, 'azure', 'x.json'), { home, cwd: proj, env }).kind, 'credential');
  assert.equal(policy.classifyPath(path.join(home, 'notes', 'x.txt'), { home, cwd: proj, env }), null);
});

/* ------------------------------ globs and braces ------------------------------ */

test('a glob or brace list that could name a credential is treated as naming it', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: {} };
  assert.equal(policy.classifyWord('~/.aws/cred*', opts).kind, 'credential');
  assert.equal(policy.classifyWord('~/.aws/cred{entials,s}', opts).kind, 'credential');
  assert.equal(policy.classifyWord('~/.a?s/credentials', opts).kind, 'credential');
  assert.equal(policy.classifyWord('~/.ssh/id_*', opts).kind, 'credential');
  assert.equal(policy.classifyWord('~/.zn/*', opts).kind, 'zn_state');
  assert.equal(policy.classifyWord('.e*', opts).kind, 'credential', 'a .env pattern in the project');
  assert.equal(policy.classifyWord('~/Documents/*.txt', opts), null);
  assert.equal(policy.classifyWord('src/*.js', opts), null);
  assert.deepEqual(policy.expandBraces('a{b,c}d'), ['abd', 'acd']);
  assert.equal(policy.expandBraces('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}'), null, 'too many alternatives');
});

test('a shell command with a glob on a credential path is refused', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: {} };
  assert.match(policy.bashDenial('cat ~/.aws/cred*', opts), /credential/);
  assert.match(policy.bashDenial('cat ~/.aws/cred{entials,s}', opts), /credential/);
  assert.equal(policy.bashDenial('ls ~/Documents/*.txt', opts), null);
});

test('command substitution: the words inside $( ) and backticks are checked too', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: {} };
  assert.match(policy.bashDenial('echo $(cat ~/.aws/credentials)', opts), /credential/);
  assert.match(policy.bashDenial('echo `cat ~/.aws/credentials`', opts), /credential/);
  assert.match(policy.bashDenial('cat "$KUBECONFIG"', opts), /credential/);
  assert.equal(policy.bashDenial('echo $(date)', opts), null);
});

test('a Windows path with backslashes is classified: the separators are not shell escapes', () => {
  // Built from strings, so the test is the same on every system.
  const opts = { home: 'C:\\Users\\me', cwd: 'C:\\Users\\me\\proj', env: {} };
  assert.match(policy.bashDenial('type C:\\Users\\me\\.aws\\credentials', opts), /credential/);
  assert.match(policy.bashDenial('Get-Content "C:\\Users\\me\\.aws\\credentials"', opts), /credential/);
  assert.equal(policy.bashDenial('Get-Content C:\\Users\\me\\proj\\src\\app.js', opts), null);
});

test('a --option=path carries its path too', (t) => {
  const { home, proj } = tmpHome(t);
  assert.match(policy.bashDenial('kubectl get pods --kubeconfig=~/.kube/config', { home, cwd: proj, env: {} }), /credential/);
});

/* ------------------------ agent hook configuration ------------------------ */

test('the agents hook and plugin configuration cannot be written, but can be read', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: {} };
  const protectedFiles = [
    path.join(home, '.claude', 'settings.json'),
    path.join(proj, '.claude', 'settings.local.json'),
    path.join(home, '.codex', 'hooks.json'),
    path.join(home, '.cursor', 'hooks.json'),
    path.join(proj, 'opencode.json'),
    path.join(home, '.config', 'opencode', 'plugins', 'zn-gate.js'),
    path.join(proj, '.opencode', 'plugins', 'zn-gate.js'),
  ];
  for (const f of protectedFiles) {
    assert.match(policy.writeDenial(f, opts), /protected/, f);
    assert.equal(policy.readDenial(f, opts), null, f);
  }
  assert.equal(policy.writeDenial(path.join(proj, 'src', 'app.js'), opts), null);
});

test('shell commands cannot write the agents hook configuration', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: {} };
  assert.match(policy.bashDenial('echo {} > ~/.claude/settings.json', opts), /protected/);
  assert.match(policy.bashDenial('sed -i s/a/b/ ~/.cursor/hooks.json', opts), /protected/);
  assert.match(policy.bashDenial('cat ~/.claude/settings.json > /dev/null; rm ~/.claude/settings.json', opts), /protected/);
  assert.match(policy.bashDenial('python3 -c "open(\'.cursor/hooks.json\',\'w\')"', opts), /protected/);
  assert.equal(policy.bashDenial('cat ~/.claude/settings.json', opts), null, 'reading is allowed');
  assert.equal(policy.bashDenial('ls -la', opts), null);
});

test('the agents plugin folders and plugin state cannot be written or removed, but can be read', (t) => {
  const { home, proj } = tmpHome(t);
  const moved = path.join(home, 'claude-other');
  const codexHome = path.join(home, 'codex-home');
  const cache = path.join(home, 'plugin-cache');
  const opts = { home, cwd: proj, env: { CLAUDE_CONFIG_DIR: moved, CODEX_HOME: codexHome, CLAUDE_CODE_PLUGIN_CACHE_DIR: cache } };
  const protectedPaths = [
    path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    path.join(home, '.claude', 'plugins', 'known_marketplaces.json'),
    path.join(home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate', '1.14.0', 'hooks', 'hooks.json'),
    path.join(home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate', '1.14.0', 'scripts', 'zn-node.sh'),
    path.join(home, '.claude', 'plugins'),
    path.join(moved, 'plugins', 'installed_plugins.json'),
    path.join(moved, 'plugins', 'cache', 'm', 'p', '1.0.0', 'hooks', 'hooks.json'),
    path.join(home, '.codex', 'plugins', 'cache', 'usezn', 'zn-gate', '1.14.0', 'hooks', 'hooks.json'),
    path.join(codexHome, 'plugins', 'cache', 'usezn', 'zn-gate', '1.14.0', 'scripts', 'zn-hook.sh'),
    path.join(home, '.cursor', 'plugins', 'zn-gate', 'hooks.json'),
    path.join(home, '.zcode', 'cli', 'plugins', 'installed_plugins.json'),
    path.join(home, '.zcode', 'cli', 'plugins', 'cache', 'usezn', 'zn-gate', '1.14.0', 'hooks', 'hooks.json'),
    path.join(home, '.gemini', 'config', 'plugins', 'zn-gate', 'hooks', 'hooks.json'),
    path.join(home, '.gemini', 'config', 'config.json'),
    path.join(home, '.gemini', 'antigravity-cli', 'plugins', 'zn-gate', 'hooks', 'hooks.json'),
    path.join(proj, '.agents', 'plugins', 'zn-gate', 'hooks', 'hooks.json'),
    path.join(cache, 'installed_plugins.json'),
    path.join(cache, 'cache', 'usezn', 'zn-gate', '1.14.0', 'scripts', 'zn-node.sh'),
    cache,
  ];
  for (const f of protectedPaths) {
    assert.match(policy.writeDenial(f, opts), /protected/, f);
    assert.equal(policy.readDenial(f, opts), null, f);
  }
  // The folders that hold them cannot be removed or moved as a whole either.
  for (const d of [path.join(home, '.zcode'), path.join(home, '.zcode', 'cli'), path.join(home, '.gemini'), path.join(home, '.gemini', 'config')]) {
    assert.match(policy.writeDenial(d, opts), /protected/, d);
  }
  // Other files in those folders and in the project stay writable.
  assert.equal(policy.writeDenial(path.join(proj, 'plugins', 'my-plugin.js'), opts), null);
  assert.equal(policy.writeDenial(path.join(home, '.gemini', 'notes.md'), opts), null);
});

test('shell commands cannot change or remove the agents plugins, and can read them', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: {} };
  for (const cmd of [
    'rm -rf ~/.claude/plugins',
    'rm -rf ~/.claude/plugins/cache/usezn/zn-gate',
    'echo {} > ~/.claude/plugins/installed_plugins.json',
    'sed -i s/zn-gate/x/ ~/.zcode/cli/plugins/installed_plugins.json',
    'rm -rf ~/.zcode',
    'mv ~/.gemini/config ~/.gemini/config.bak',
    'echo {} > ~/.gemini/config/config.json',
    'rm -r ~/.codex/plugins/cache/usezn',
    'cp evil.sh ~/.cursor/plugins/zn-gate/scripts/zn-launch.js',
  ]) {
    assert.match(policy.bashDenial(cmd, opts) || '', /protected/, cmd);
  }
  assert.equal(policy.bashDenial('cat ~/.claude/plugins/installed_plugins.json', opts), null, 'reading is allowed');
  assert.equal(policy.bashDenial('ls ~/.zcode/cli/plugins', opts), null, 'listing is allowed');
});

test('Antigravity CLI folder: removing or moving it is refused, like the other plugin folders', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: {} };
  for (const cmd of ['rm -rf ~/.gemini/antigravity-cli', 'mv ~/.gemini/antigravity-cli ~/.gemini/x', 'rm -r ~/.gemini/antigravity-cli/plugins']) {
    assert.match(policy.bashDenial(cmd, opts) || '', /protected/, cmd);
  }
  assert.match(policy.writeDenial(path.join(home, '.gemini', 'antigravity-cli'), opts), /protected/);
});

test('a project folder named like an agent folder is not the agent plugin folder: only the home (and the moved folders) count', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: {} };
  // In the project: allowed (Gemini CLI keeps its project settings in .gemini/, monorepos have nested .claude/ folders).
  for (const cmd of ['mkdir -p .gemini', 'rm -rf .gemini', 'rm -rf .zcode', 'mv .gemini/config .gemini/old',
    'echo {} > packages/x/.claude/plugins/foo.json', 'rm -rf packages/x/.agents/plugins']) {
    assert.equal(policy.bashDenial(cmd, opts), null, cmd);
  }
  for (const f of [path.join(proj, '.gemini'), path.join(proj, '.gemini', 'config', 'config.json'),
    path.join(proj, 'packages', 'x', '.claude', 'plugins', 'foo.json'), path.join(proj, 'packages', 'x', '.codex', 'plugins', 'a', 'b.json'),
    path.join(proj, 'sub', '.agents', 'plugins', 'p', 'hooks.json')]) {
    assert.equal(policy.writeDenial(f, opts), null, f);
  }
  // The same names in the home folder, and .agents/plugins at the project root: refused.
  for (const cmd of ['rm -rf ~/.gemini', 'mkdir -p ~/.gemini/config', 'echo {} > ~/.claude/plugins/foo.json', 'rm -rf .agents/plugins']) {
    assert.match(policy.bashDenial(cmd, opts) || '', /protected/, cmd);
  }
  assert.match(policy.writeDenial(path.join(proj, '.agents', 'plugins', 'p', 'hooks.json'), opts), /protected/);
});

test('~/.zn and the plugin folders through a linked home or project: the real path is protected too', { skip: WIN }, (t) => {
  const base = tempDir(t, 'zn-linkhome-');
  const realHome = path.join(base, 'data', 'u');
  fs.mkdirSync(realHome, { recursive: true });
  const home = path.join(base, 'home-u');
  fs.symlinkSync(realHome, home);
  const realProj = path.join(base, 'data', 'proj');
  fs.mkdirSync(realProj, { recursive: true });
  const proj = path.join(base, 'proj-link');
  fs.symlinkSync(realProj, proj);
  const opts = { home, cwd: proj, env: {} };
  for (const f of [path.join(realHome, '.claude', 'plugins', 'installed_plugins.json'), path.join(realHome, '.zn', 'vault.age'),
    path.join(realHome, '.gemini', 'antigravity-cli'), path.join(realProj, '.agents', 'plugins', 'p', 'hooks.json')]) {
    assert.match(policy.writeDenial(f, opts) || '', /protected|\.zn/, f);
  }
  assert.match(policy.bashDenial('rm -rf ' + realHome + '/.gemini/antigravity-cli', opts) || '', /protected/);
  assert.ok(policy.bashDenial('rm -rf ' + realHome + '/.zn', opts), 'rm -rf of the real ~/.zn');
  assert.equal(policy.writeDenial(path.join(realHome, 'notes.md'), opts), null);
});

test('variables, command substitution and ~user in a write target that may be the home folder', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: { HOME: home } };
  for (const cmd of [
    'X=$HOME; rm -rf $X/.claude/plugins',
    'X=' + home + '; rm -rf $X/.zn',
    'export D=~/.zn && rm -rf $D',
    'rm -rf $UNSET_DIR/.zn',
    'rm -rf ${SOMEWHERE}/.gemini/antigravity-cli',
    'rm -rf `echo ~`/.gemini/antigravity-cli',
    'rm -rf ~other/.gemini/antigravity-cli',
    'echo {} > $H/.claude/plugins/installed_plugins.json',
  ]) {
    assert.ok(policy.bashDenial(cmd, opts), cmd);
  }
  // A substitution whose output may be the home folder.
  assert.ok(policy.bashDenial('rm -rf $(echo ~)/.claude/plugins', opts));
  assert.ok(policy.bashDenial('rm -rf $(echo ~)/.zn', opts));
  assert.ok(policy.bashDenial('rm -rf "$(dirname $PWD)"/.gemini/antigravity-cli', opts));
  // Ordinary variables and paths stay allowed.
  for (const cmd of ['X=build; rm -rf $X/out', 'rm -rf $TMPDIR/foo', 'OUT=dist; mkdir -p $OUT/.gemini', 'cat $UNSET/.zn/x']) {
    assert.equal(policy.bashDenial(cmd, opts), null, cmd);
  }
});

test('a relative write after a cd into the home folder, or to a place zn cannot follow', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: { HOME: home } };
  for (const cmd of ['cd ~ && rm -rf .gemini/antigravity-cli', 'cd && rm -rf .zn', 'cd $HOME && rm -rf .claude/plugins',
    'cd ~/.gemini && rm -rf antigravity-cli', 'cd $SOMEWHERE && rm -rf .zn', 'cd ~ ; echo {} > .claude/plugins/installed_plugins.json']) {
    assert.ok(policy.bashDenial(cmd, opts), cmd);
  }
  for (const cmd of ['cd src && rm -rf .gemini', 'cd ~ && rm -rf tmp', 'cd ~ && cat .zn/x', 'cd build && rm -rf .zn-cache']) {
    assert.equal(policy.bashDenial(cmd, opts), null, cmd);
  }
});

test('a home of "/" or a relative home still protects .zn and the plugin folders', (t) => {
  const opts = { home: '/', cwd: '/tmp', env: {} };
  assert.ok(policy.writeDenial('/.zn/vault.age', opts));
  assert.match(policy.writeDenial('/.claude/plugins/installed_plugins.json', opts) || '', /protected/);
  assert.equal(policy.writeDenial('/srv/app/.zn-cache', opts), null);
});

test('a variable set from a command, set twice, or used without a slash counts as unknown, so it may be the home folder', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: { HOME: home } };
  for (const cmd of [
    'X=$(echo ~); rm -rf $X/.zn',
    'X="$(echo ~)"; rm -rf "$X"/.zn',
    'X=`echo ~`; rm -rf $X/.claude/plugins',
    'H=$(echo ~/); rm -rf ${H}.zn',
    'X=/tmp; X=$HOME; rm -rf $X/.zn',
    'X=$HOME; X=/tmp; rm -rf $X/.gemini/antigravity-cli',
    'rm -rf ${H}.zn',
    'Y=$UNSET; rm -rf $Y/.zn',
  ]) {
    assert.ok(policy.bashDenial(cmd, opts), cmd);
  }
  for (const cmd of ['X=$(pwd); rm -rf $X/build', 'X=/tmp; X=/var/tmp; rm -rf $X/cache', 'rm -rf ${OUT}dist']) {
    assert.equal(policy.bashDenial(cmd, opts), null, cmd);
  }
});

test('env -C, git -C and find -delete or -exec rm under the home folder are followed', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: { HOME: home } };
  for (const cmd of [
    'env -C ~ rm -rf .zn',
    'env --chdir=' + home + ' rm -rf .claude/plugins',
    'git -C ~ rm -rf --cached .gemini/antigravity-cli',
    'find ~ -name .zn -exec rm -rf {} +',
    'find ' + home + ' -name plugins -delete',
    'find / -path "*antigravity-cli*" -delete',
    'find $HOME -name installed_plugins.json -exec rm {} \\;',
  ]) {
    assert.ok(policy.bashDenial(cmd, opts), cmd);
  }
  for (const cmd of ['env -C build rm -rf out', 'git -C src clean -fdx', 'find . -name "*.pyc" -delete', 'find ~ -name .zn',
    'find ~/proj -name node_modules -exec rm -rf {} +']) {
    assert.equal(policy.bashDenial(cmd, opts), null, cmd);
  }
});

test('a linked agent configuration or plugin folder (dotfiles) is protected at its real place too', { skip: WIN }, (t) => {
  // For each agent: the configuration folder linked elsewhere, and (separately) only its plugin folder linked elsewhere.
  for (const [conf, sub] of [['.claude', 'plugins'], ['.codex', 'plugins'], ['.cursor', 'plugins'], ['.zcode/cli', 'plugins'],
    ['.gemini/config', 'plugins'], ['.gemini/antigravity-cli', 'plugins']]) {
    for (const linkWhat of ['config', 'plugins']) {
      const { home, proj } = tmpHome(t);
      const elsewhere = tempDir(t, 'zn-dotfiles-');
      const opts = { home, cwd: proj, env: { HOME: home } };
      let realPlugins;
      if (linkWhat === 'config') {
        const realConf = path.join(elsewhere, 'conf');
        fs.mkdirSync(path.join(realConf, sub, 'cache', 'zn', 'scripts'), { recursive: true });
        fs.mkdirSync(path.dirname(path.join(home, conf)), { recursive: true });
        fs.symlinkSync(realConf, path.join(home, conf));
        realPlugins = path.join(realConf, sub);
      } else {
        realPlugins = path.join(elsewhere, 'plugins');
        fs.mkdirSync(path.join(realPlugins, 'cache', 'zn', 'scripts'), { recursive: true });
        fs.mkdirSync(path.join(home, conf), { recursive: true });
        fs.symlinkSync(realPlugins, path.join(home, conf, sub));
      }
      const launcher = path.join(realPlugins, 'cache', 'zn', 'scripts', 'zn-launch.js');
      fs.writeFileSync(launcher, '');
      const label = conf + ' linked ' + linkWhat;
      assert.ok(policy.writeDenial(path.join(home, conf, sub, 'cache', 'zn', 'scripts', 'zn-launch.js'), opts), label + ': logical path');
      assert.ok(policy.writeDenial(launcher, opts), label + ': real path');
      assert.ok(policy.bashDenial('printf x > ' + launcher, opts), label + ': redirect to the real path');
      assert.ok(policy.bashDenial('rm -rf ' + realPlugins, opts), label + ': remove the real plugin folder');
      assert.equal(policy.writeDenial(path.join(elsewhere, 'notes.txt'), opts), null, label + ': a file beside it is not protected');
    }
  }
});

test('a linked Gemini or ZCode configuration folder keeps its plugin state protected at its real place', { skip: WIN }, (t) => {
  const { home, proj } = tmpHome(t);
  const elsewhere = tempDir(t, 'zn-dotfiles-');
  const opts = { home, cwd: proj, env: { HOME: home } };
  fs.mkdirSync(path.join(elsewhere, 'gemini', 'config'), { recursive: true });
  fs.writeFileSync(path.join(elsewhere, 'gemini', 'config', 'config.json'), '{}');
  fs.symlinkSync(path.join(elsewhere, 'gemini'), path.join(home, '.gemini'));
  fs.mkdirSync(path.join(elsewhere, 'zcode', 'cli'), { recursive: true });
  fs.symlinkSync(path.join(elsewhere, 'zcode'), path.join(home, '.zcode'));
  assert.ok(policy.writeDenial(path.join(elsewhere, 'gemini', 'config', 'config.json'), opts));
  assert.ok(policy.bashDenial('rm -rf ' + path.join(elsewhere, 'gemini'), opts));
  assert.ok(policy.bashDenial('rm -rf ' + path.join(elsewhere, 'zcode', 'cli'), opts));
  assert.equal(policy.writeDenial(path.join(elsewhere, 'gemini', 'notes.md'), opts), null);
});

test('a linked plugin folder named by CLAUDE_CONFIG_DIR or CODEX_HOME is protected at its real place', { skip: WIN }, (t) => {
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    const { home, proj } = tmpHome(t);
    const elsewhere = tempDir(t, 'zn-dotfiles-');
    const conf = path.join(home, 'agent-conf');
    const realPlugins = path.join(elsewhere, 'plugins');
    fs.mkdirSync(realPlugins, { recursive: true });
    fs.mkdirSync(conf);
    fs.symlinkSync(realPlugins, path.join(conf, 'plugins'));
    const opts = { home, cwd: proj, env: { HOME: home, [name]: conf } };
    assert.ok(policy.writeDenial(path.join(realPlugins, 'zn-launch.js'), opts), name);
  }
});

test('a Codex patch is refused when any file in it is protected, and an unreadable patch too', async (t) => {
  const { home, proj } = tmpHome(t);
  const settings = path.join(home, '.claude', 'settings.json');
  const cx = (patch) => ({ session_id: 's', transcript_path: '/t', cwd: proj, hook_event_name: 'PreToolUse', model: 'm', tool_name: 'apply_patch', tool_input: { command: patch } });
  const ok = await run(codex, cx('*** Begin Patch\n*** Update File: src/a.js\n@@\n-a\n+b\n*** End Patch'), { home });
  assert.notEqual(ok.output && ok.output.hookSpecificOutput && ok.output.hookSpecificOutput.permissionDecision, 'deny');
  const second = await run(codex, cx('*** Begin Patch\n*** Update File: src/a.js\n*** Add File: ' + settings + '\n+x\n*** End Patch'), { home });
  assert.equal(second.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(second.output.hookSpecificOutput.permissionDecisionReason, /protected/);
  const unreadable = await run(codex, cx('not a patch'), { home });
  assert.equal(unreadable.output.hookSpecificOutput.permissionDecision, 'deny');
});

test('Codex tokenizes the output of tools it does not know, like MCP output', async (t) => {
  const { home, proj } = tmpHome(t);
  const raw = { session_id: 's', transcript_path: '/t', cwd: proj, hook_event_name: 'PostToolUse', model: 'm',
    tool_name: 'web_search', tool_use_id: 'u1', tool_input: {}, tool_response: 'found key=' + AWS };
  const res = await run(codex, raw, { home });
  assert.equal(res.output.decision, 'block');
  assert.ok(!res.output.reason.includes(AWS));
});

test('the hook reads an event that starts with a byte order mark (Windows PowerShell pipes one)', (t) => {
  const { spawnSync } = require('child_process');
  const { home, proj } = tmpHome(t);
  const ev = { session_id: 's', transcript_path: '/t', cwd: proj, hook_event_name: 'PreToolUse', model: 'm', tool_name: 'Bash',
    tool_input: { command: 'cat ' + path.join(home, '.aws', 'credentials') } };
  const res = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js'), 'codex'], {
    input: '﻿' + JSON.stringify(ev), env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /"permissionDecision":"deny"/);
  assert.doesNotMatch(res.stderr, /invalid event JSON/);
});

test('Cursor preToolUse checks the file a write, delete or grep names, and fails closed without a path', async (t) => {
  const { home, proj } = tmpHome(t);
  const pre = (tool, input) => ({ hook_event_name: 'preToolUse', tool_name: tool, tool_input: input, cwd: proj, conversation_id: 'c' });
  const denied = await run(cursor, pre('Write', { file_path: path.join(home, '.cursor', 'hooks.json'), content: 'x' }), { home });
  assert.equal(denied.output.permission, 'deny');
  const del = await run(cursor, pre('Delete', { file_path: path.join(home, '.codex', 'hooks.json') }), { home });
  assert.equal(del.output.permission, 'deny');
  const grep = await run(cursor, pre('Grep', { pattern: 'x', path: path.join(home, '.aws', 'credentials') }), { home });
  assert.equal(grep.output.permission, 'deny');
  // An allowed write gets no answer: "allow" could skip Cursor's own confirmations.
  const ok = await run(cursor, pre('Write', { file_path: path.join(proj, 'src', 'a.js'), content: 'x' }), { home });
  assert.equal(ok.output, null);
  const noPath = await run(cursor, pre('Write', { content: 'x' }), { home });
  assert.equal(noPath.output.permission, 'deny', 'a write whose path cannot be read is refused');
});

test('Cursor install: failClosed on beforeReadFile and beforeSubmitPrompt, and a matcher on preToolUse', { skip: process.platform === 'win32' }, (t) => {
  const { home, proj } = tmpHome(t);
  cursor.install({ home, scope: 'user', nodePath: process.execPath, runnerPath: '/opt/zn/runner.js' });
  const data = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8'));
  assert.equal(data.hooks.beforeReadFile[0].failClosed, true);
  assert.equal(data.hooks.beforeSubmitPrompt[0].failClosed, true);
  assert.equal(data.hooks.beforeShellExecution[0].failClosed, undefined);
  assert.equal(data.hooks.preToolUse[0].matcher, 'Grep|Write|Delete');
  assert.match(fs.readFileSync(path.join(home, '.zn', 'hooks', 'zn-hook-cursor.sh'), 'utf8'), /^ZN_RUNNER='\/opt\/zn\/runner\.js'$/m);
  void proj;
});

test('OpenCode: a command runs from its workdir, apply_patch names every file, and output of its text tools is tokenized', () => {
  const pre = opencode.normalize({ hook: 'tool.execute.before', tool: 'bash', args: { command: 'ls', workdir: 'sub' }, cwd: '/proj' });
  assert.equal(pre.cwd, path.resolve('/proj', 'sub'));
  const patch = opencode.normalize({ hook: 'tool.execute.before', tool: 'apply_patch', args: { patchText: '*** Begin Patch\n*** Update File: a.js\n*** Add File: b.js\n*** End Patch' }, cwd: '/proj' });
  assert.deepEqual(patch.input.paths, ['a.js', 'b.js']);
  assert.equal(opencode.normalize({ hook: 'tool.execute.before', tool: 'apply_patch', args: { patchText: 'nothing' }, cwd: '/proj' }).input.unparsed, true);
  for (const t of ['task', 'websearch', 'glob', 'list', 'skill', 'codesearch']) {
    assert.equal(opencode.normalize({ hook: 'tool.execute.after', tool: t, args: {}, output: 'x', cwd: '/proj' }).tool, 'mcp', t);
  }
});

test('OpenCode plugin: only known actions are acted on, and a project plugin names no path of this user', () => {
  const user = opencode.pluginSource({ nodePath: '/usr/bin/node', runnerPath: '/opt/zn/runner.js', scope: 'user' });
  assert.match(user, /const ACTIONS = \["none", "deny", "error", "args", "output"\];/);
  assert.match(user, /!ACTIONS\.includes\(answer\.action\)/);
  assert.ok(user.includes('/opt/zn/runner.js'));
  const project = opencode.pluginSource({ nodePath: '/usr/bin/node', runnerPath: '/opt/zn/runner.js', scope: 'project' });
  assert.match(project, /const NODE = "zn";/);
  assert.ok(!project.includes('/opt/zn/runner.js'));
  assert.ok(!project.includes('/usr/bin/node'));
});

/* ------------------------------ install files ------------------------------ */

test('config files: a symlinked file is written through, its mode is kept, and bad content is refused', { skip: WIN }, (t) => {
  const dir = tempDir(t, 'zn-cfg-');
  const target = path.join(dir, 'real.json');
  const link = path.join(dir, 'link.json');
  fs.writeFileSync(target, '{}\n', { mode: 0o600 });
  fs.symlinkSync(target, link);
  cfg.writeJson(link, { hooks: {} });
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link stays');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { hooks: {} });

  fs.writeFileSync(path.join(dir, 'null.json'), 'null');
  assert.throws(() => cfg.readJson(path.join(dir, 'null.json')), /must hold a JSON object, not null/);
  fs.writeFileSync(path.join(dir, 'arr.json'), '[]');
  assert.throws(() => cfg.readJson(path.join(dir, 'arr.json')), /not an array/);
  assert.throws(() => cfg.hooksOf({ hooks: [] }, 'x.json'), /"hooks" in x\.json must be an object/);
  assert.deepEqual(cfg.hooksOf({}, 'x.json'), {});
  assert.deepEqual(cfg.hooksOf({ hooks: null }, 'x.json'), {});
});

test('hook commands: a project install names zn on PATH, and paths are single-quoted for sh', () => {
  assert.equal(cfg.hookCommand('codex', { scope: 'project', nodePath: '/n/node', runnerPath: '/r/runner.js' }), 'zn hook codex');
  assert.equal(cfg.hookCommandWindows('codex', { scope: 'project' }), 'zn hook codex');
  assert.equal(cfg.quoteArg('/a$b/`x`/c', 'linux'), "'/a$b/`x`/c'");
  const user = cfg.hookCommand('codex', { scope: 'user', nodePath: '/n/node', runnerPath: '/r/runner.js', platform: 'linux' });
  assert.equal(user, "'/n/node' '/r/runner.js' codex");
  const win = cfg.hookCommandWindows('codex', { scope: 'user', nodePath: 'C:\\Program Files\\nodejs\\node.exe', runnerPath: "C:\\it's\\runner.js" });
  assert.match(win, /^C:\/Windows\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -NonInteractive -Command "& 'C:\/Program Files\/nodejs\/node\.exe' 'C:\/it''s\/runner\.js' codex"$/);
});
