'use strict';
/*
 * zn's own install is off limits to the agent's write tools and shell: the Claude Code plugin files, the installed
 * zn-gate package (one write of process.exit(0) over runner.js would turn every hook into a no-op), a file named like
 * the zn command in a PATH folder, and the commands that uninstall zn or switch the plugin off. Reads stay allowed.
 * Everything runs in a temporary home; nothing here touches the real ~/.claude, ~/.zn or ~/.local/bin.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const policy = require('../lib/hooks/policy');
const runner = require('../lib/hooks/runner');
const adapter = require('../lib/agents/claude-code');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

function setup(t) {
  const home = tempDir(t, 'zn-inst-');
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const env = { PATH: [path.join(home, '.local', 'bin'), '/usr/bin'].join(path.delimiter) };
  return { home, project, env, opts: { home, cwd: project, env } };
}

function withPlatform(name, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: name });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', real); }
}

const PLUGIN_FILES = [
  '.claude/plugins/cache/usezn/zn-gate/1.13.1/scripts/zn-launch.js',
  '.claude/plugins/cache/usezn/zn-gate/1.13.1/hooks/hooks.json',
  '.claude/plugins/cache/usezn/zn-gate/1.13.1/scripts/zn-gate.lock.json',
  '.claude/plugins/installed_plugins.json',
  '.claude/plugins/known_marketplaces.json',
  '.claude/plugins/marketplaces/usezn/plugins/zn-gate/hooks/hooks.json',
];
const PACKAGE_FILES = [
  '.npm-global/lib/node_modules/zn-gate/lib/hooks/runner.js',
  '.nvm/versions/node/v22.1.0/lib/node_modules/zn-gate/lib/hooks/runner.js',
  '.volta/tools/image/packages/zn-gate/lib/node_modules/zn-gate/lib/hooks/runner.js',
  'AppData/Roaming/npm/node_modules/zn-gate/lib/hooks/runner.js',
  'project/node_modules/zn-gate/lib/hooks/runner.js',
  '.npm/_npx/abc123/node_modules/zn-gate/lib/hooks/policy.js',
  'project/node_modules/.bin/zn-gate',
];
const SYSTEM_PACKAGE_FILES = [
  '/usr/lib/node_modules/zn-gate/lib/hooks/runner.js',
  '/usr/local/lib/node_modules/zn-gate/lib/hooks/runner.js',
  '/opt/homebrew/lib/node_modules/zn-gate/lib/hooks/runner.js',
  '/usr/local/bin/zn',
];
const BIN_FILES = [
  '.local/bin/zn', '.local/bin/zn-gate', '.local/bin/zn.cmd', '.local/bin/zn-gate.cmd', '.local/bin/zn-hook-claude-code',
  'bin/zn', 'bin/zn-gate', '.npm-global/bin/zn', '.cargo/bin/zn-gate',
];

test('writes to the plugin files, the installed package and a fake zn are denied; reads are allowed', (t) => {
  const { home, opts } = setup(t);
  for (const rel of [...PLUGIN_FILES, ...PACKAGE_FILES, ...BIN_FILES]) {
    const p = path.join(home, rel);
    assert.match(String(policy.writeDenial(p, opts)), /protected/, 'write ' + rel);
    assert.equal(policy.readDenial(p, opts), null, 'read ' + rel);
  }
  for (const p of SYSTEM_PACKAGE_FILES) {
    assert.match(String(policy.writeDenial(p, opts)), /protected/, 'write ' + p);
    assert.equal(policy.readDenial(p, opts), null, 'read ' + p);
  }
});

test('the same files by ~, a relative path, ..\\ and $HOME', (t) => {
  const { home, project, opts } = setup(t);
  assert.match(String(policy.writeDenial('~/.claude/plugins/installed_plugins.json', opts)), /plugin files/);
  assert.match(String(policy.writeDenial('$HOME/.claude/plugins/installed_plugins.json', opts)), /plugin files/);
  assert.match(String(policy.writeDenial('../.local/bin/zn', opts)), /named like the zn command/);
  assert.match(String(policy.writeDenial('../.claude/plugins/x/hooks/hooks.json', opts)), /plugin files/);
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  assert.match(String(policy.writeDenial(path.join(project, '..', '.claude', 'plugins', 'a', '..', 'installed_plugins.json'), opts)), /plugin files/);
});

test('a link to the plugin folder or to the runner does not get around it', (t) => {
  const { home, project, opts } = setup(t);
  const plugins = path.join(home, '.claude', 'plugins', 'cache');
  fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(path.join(plugins, 'x.js'), 'x');
  fs.symlinkSync(plugins, path.join(project, 'plug'));
  fs.symlinkSync(path.join(plugins, 'x.js'), path.join(project, 'x-link.js'));
  assert.match(String(policy.writeDenial(path.join(project, 'plug', 'x.js'), opts)), /plugin files/);
  assert.match(String(policy.writeDenial(path.join(project, 'x-link.js'), opts)), /plugin files/);
  // a link in a PATH folder to the installed runner
  const pkg = path.join(home, '.npm-global', 'lib', 'node_modules', 'zn-gate', 'bin');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'cli.js'), 'x');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.symlinkSync(path.join(pkg, 'cli.js'), path.join(home, '.local', 'bin', 'zn'));
  assert.match(String(policy.writeDenial(path.join(home, '.local', 'bin', 'zn'), opts)), /protected/);
  assert.match(String(policy.writeDenial(path.join(project, 'sub', '..', 'plug', 'x.js'), opts)), /plugin files/);
});

test('the environment can name the plugin folders', (t) => {
  const { home, project } = setup(t);
  const root = path.join(home, 'elsewhere');
  const env = { PATH: '/usr/bin', CLAUDE_PLUGIN_ROOT: path.join(root, 'root'), CLAUDE_CONFIG_DIR: path.join(root, 'cfg'), CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(root, 'cache') };
  const opts = { home, cwd: project, env };
  for (const p of ['root/scripts/zn-launch.js', 'cfg/plugins/installed_plugins.json', 'cache/zn-gate/hooks/hooks.json']) {
    assert.match(String(policy.writeDenial(path.join(root, p), opts)), /plugin files/, p);
  }
  assert.equal(policy.writeDenial(path.join(root, 'other', 'file.txt'), opts), null);
});

test('PATH folders from the environment count for a file named like zn', (t) => {
  const { home, project } = setup(t);
  const custom = path.join(home, 'my', 'tools');
  const opts = { home, cwd: project, env: { PATH: custom + path.delimiter + 'relative/dir' + path.delimiter + '.' } };
  assert.match(String(policy.writeDenial(path.join(custom, 'zn'), opts)), /named like the zn command/);
  assert.equal(policy.writeDenial(path.join(custom, 'notes.md'), opts), null);
  // relative PATH entries are not followed: a zn file in the project is the project's own
  assert.equal(policy.writeDenial(path.join(project, 'zn'), opts), null);
  assert.equal(policy.writeDenial(path.join(project, 'relative', 'dir', 'zn'), opts), null);
});

test('ordinary files stay writable', (t) => {
  const { home, project, opts } = setup(t);
  for (const p of [
    path.join(project, 'zn'), path.join(project, 'src', 'zn-gate.js'), path.join(project, 'README.md'),
    path.join(project, 'node_modules', 'other-package', 'index.js'), path.join(home, '.local', 'bin', 'my-tool'),
    path.join(home, '.local', 'bin', 'zn-notes.md'), path.join(home, '.claude', 'projects', 'x', 'notes.txt'),
    path.join(home, 'usezn', 'zn', 'file.txt'),
  ]) {
    assert.equal(policy.writeDenial(p, opts), null, p);
  }
});

test('case-insensitive on macOS and Windows, NTFS streams on Windows', (t) => {
  const { home, opts } = setup(t);
  withPlatform('darwin', () => {
    assert.match(String(policy.writeDenial(path.join(home, '.CLAUDE', 'Plugins', 'Installed_Plugins.json'), opts)), /plugin files/);
    assert.match(String(policy.writeDenial(path.join(home, '.Local', 'BIN', 'ZN'), opts)), /named like the zn command/);
    assert.match(String(policy.writeDenial(path.join(home, 'x', 'Node_Modules', 'ZN-Gate', 'lib', 'hooks', 'RUNNER.js'), opts)), /installed zn-gate package/);
  });
  withPlatform('win32', () => {
    assert.match(String(policy.writeDenial(path.join(home, '.claude', 'plugins', 'installed_plugins.json') + '::$DATA', opts)), /plugin files/);
    assert.match(String(policy.writeDenial(path.join(home, '.claude', 'plugins', 'installed_plugins.json') + ':stream', opts)), /plugin files/);
    assert.match(String(policy.writeDenial(path.join(home, 'x', 'node_modules', 'zn-gate', 'lib', 'hooks', 'runner.js') + '::$DATA', opts)), /installed zn-gate package/);
  });
  // on Linux names are case-sensitive
  assert.equal(policy.writeDenial(path.join(home, '.claude', 'PLUGINS', 'x.json'), opts), null);
});

test('the package that is running is protected, found from the module (an installed copy)', (t) => {
  const { home, project, env } = setup(t);
  // An install outside node_modules and outside a git checkout, for example a vendored copy.
  const root = path.join(home, 'vendored', 'zn');
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  const src = path.join(__dirname, '..');
  for (const d of ['lib', 'bin']) fs.cpSync(path.join(src, d), path.join(root, d), { recursive: true });
  fs.copyFileSync(path.join(src, 'package.json'), path.join(root, 'package.json'));
  const copy = require(path.join(root, 'lib', 'hooks', 'policy.js'));
  const opts = { home, cwd: project, env };
  assert.match(String(copy.writeDenial(path.join(root, 'lib', 'hooks', 'runner.js'), opts)), /installed zn-gate package/);
  assert.match(String(copy.writeDenial(path.join(root, 'lib', 'brand-new-file.js'), opts)), /installed zn-gate package/);
  assert.match(String(copy.writeDenial(path.join(root, 'package.json'), opts)), /installed zn-gate package/);
  assert.equal(copy.readDenial(path.join(root, 'lib', 'hooks', 'runner.js'), opts), null);
  assert.equal(copy.writeDenial(path.join(project, 'file.js'), opts), null);
  // and as node_modules/zn-gate in a global prefix, through a link
  const prefix = path.join(home, '.npm-global', 'lib', 'node_modules');
  fs.mkdirSync(prefix, { recursive: true });
  fs.symlinkSync(root, path.join(prefix, 'zn-gate'));
  assert.match(String(policy.writeDenial(path.join(prefix, 'zn-gate', 'lib', 'hooks', 'runner.js'), opts)), /protected/);
});

test('a source checkout of zn-gate is not protected (agents work on zn-gate there)', (t) => {
  const { home, project, env } = setup(t);
  const root = path.resolve(__dirname, '..');
  if (!fs.existsSync(path.join(root, '..', '..', '.git'))) return t.skip('not a git checkout');
  assert.equal(policy.writeDenial(path.join(root, 'lib', 'hooks', 'runner.js'), { home, cwd: project, env }), null);
});

test('the package root can be given explicitly', (t) => {
  const { home, project, env } = setup(t);
  const root = path.join(home, 'any', 'place');
  const opts = { home, cwd: project, env, packageRoot: root };
  assert.match(String(policy.writeDenial(path.join(root, 'lib', 'hooks', 'runner.js'), opts)), /installed zn-gate package/);
});

const DENIED_COMMANDS = [
  'npm uninstall -g zn-gate', 'npm rm -g zn-gate', 'npm remove --global zn-gate', 'npm un -g zn-gate@1.13.1', 'sudo npm uninstall -g zn-gate',
  'npm -g uninstall zn-gate', 'npm uninstall zn-gate --global', 'npm --prefix /x uninstall zn-gate', 'npm uninstall other zn-gate',
  'pnpm remove -g zn-gate', 'pnpm rm zn-gate -g', 'yarn global remove zn-gate', 'bun remove -g zn-gate', 'volta uninstall zn-gate',
  'pip uninstall zn-gate', 'pip uninstall -y zn-gate', 'pip3 uninstall zn_gate', 'python3 -m pip uninstall zn-gate', 'pipx uninstall zn-gate',
  'uv pip uninstall zn-gate', 'uv tool uninstall zn-gate', 'pip uninstall -y zn-gate==1.13.1',
  'claude plugin disable zn-gate', 'claude plugin disable zn-gate@usezn', 'claude plugin uninstall zn-gate', 'claude plugin uninstall zn-gate@usezn --scope user',
  'claude plugins remove zn-gate', 'claude plugin marketplace remove usezn', 'claude plugin marketplace rm usezn',
  'cd /tmp && npm uninstall -g zn-gate', 'echo x; claude plugin disable zn-gate', 'true || pip uninstall zn-gate',
  'sh -c "npm uninstall -g zn-gate"', "bash -c 'claude plugin disable zn-gate'", 'CLAUDE_CONFIG_DIR=/x claude plugin disable zn-gate',
  '/usr/bin/npm uninstall -g zn-gate', 'npm.cmd uninstall -g zn-gate', 'env npm uninstall -g zn-gate', 'echo $(npm uninstall -g zn-gate)',
  'npm uninstall -g "zn-gate"', "npm uninstall -g 'zn-gate'",
];
const ALLOWED_COMMANDS = [
  'npm install -g other-package', 'npm install -g zn-gate', 'npm uninstall -g other-package', 'npm uninstall left-pad', 'pip uninstall requests',
  'pip install zn-gate', 'pip install -U zn-gate', 'pipx upgrade zn-gate', 'claude plugin list', 'claude plugin disable other-plugin',
  'claude plugin marketplace list', 'claude plugin marketplace remove other-market', 'claude plugin install zn-gate@usezn',
  'claude plugin marketplace add usezn/zn', 'npm ls -g zn-gate', 'npm view zn-gate version', 'pip show zn-gate', 'yarn global add zn-gate',
  'cat ~/.claude/plugins/installed_plugins.json', 'ls ~/.claude/plugins/cache', 'cat "$(npm root -g)/zn-gate/lib/hooks/runner.js"',
  'git clone https://github.com/usezn/zn', 'cd usezn/zn && git pull', 'rm -rf node_modules/left-pad', 'echo uninstall zn-gate',
];

test('commands that uninstall zn or switch its plugin off are denied, with the next step', (t) => {
  const { opts } = setup(t);
  for (const cmd of DENIED_COMMANDS) {
    const deny = policy.bashDenial(cmd, opts);
    assert.match(String(deny), /zn blocked this/, cmd);
    assert.match(deny, /ask the user to run it themselves in their own terminal/, cmd);
  }
});

test('other package and plugin commands, and reads, stay allowed', (t) => {
  const { opts } = setup(t);
  for (const cmd of ALLOWED_COMMANDS) assert.equal(policy.bashDenial(cmd, opts), null, cmd);
});

test('shell writes and removals of the plugin files, the package and a fake zn are denied', (t) => {
  const { home, project, opts } = setup(t);
  const pkg = path.join(home, '.npm-global', 'lib', 'node_modules', 'zn-gate');
  const plug = path.join(home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate', '1.13.1');
  fs.mkdirSync(path.join(pkg, 'lib', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(plug, 'scripts'), { recursive: true });
  const cmds = [
    `rm -rf ${pkg}`, `rm -rf "${pkg}"`, `rm -rf ~/.npm-global/lib/node_modules/zn-gate`, `echo 'process.exit(0)' > ${pkg}/lib/hooks/runner.js`,
    `printf x >> ${pkg}/lib/hooks/runner.js`, `cd ${pkg}/lib/hooks && echo 'process.exit(0)' > runner.js`, `cd ${pkg} && rm -rf lib`,
    `sed -i 's/a/b/' ${pkg}/lib/hooks/runner.js`, `mv ${pkg} ${pkg}.old`, `chmod 000 ${pkg}/lib/hooks/runner.js`, `ln -sf /bin/true ${pkg}/lib/hooks/runner.js`,
    `tee ${pkg}/lib/hooks/runner.js < /dev/null`, `cp /tmp/x ${pkg}/lib/hooks/runner.js`,
    `echo x > ${plug}/scripts/zn-launch.js`, `rm ${plug}/hooks.json`, `rm -rf ~/.claude/plugins`, `echo '{}' > ~/.claude/plugins/installed_plugins.json`,
    `cd ~/.claude/plugins && echo '{}' > installed_plugins.json`, `rm -rf ~/.claude/plugins/marketplaces/usezn`, `mv ~/.claude/plugins ~/.claude/plugins.off`,
    `echo '#!/bin/sh' > ~/.local/bin/zn`, `cp /bin/true ~/.local/bin/zn-gate`, `ln -s /bin/true ~/bin/zn`, `touch ~/.local/bin/zn.cmd`, `cd ~/.local/bin && printf x > zn`,
    `install -m755 /bin/true ~/.local/bin/zn-gate`, `echo x > "$(npm root -g)/zn-gate/lib/hooks/runner.js"`, 'rm -rf $(npm root -g)/zn-gate', 'rm -rf `npm root -g`/zn-gate',
    `rm -rf $NPM_PREFIX/lib/node_modules/zn-gate`, `echo x > ~/zn-hook-claude-code.sh`,
  ];
  for (const cmd of cmds) {
    const deny = policy.bashDenial(cmd, { ...opts, cwd: project });
    assert.ok(deny, cmd);
  }
  // reads and listings of the same places are allowed
  for (const cmd of [`cat ${pkg}/lib/hooks/runner.js`, `ls ${pkg}`, `grep -r x ${plug}`, 'cat ~/.claude/plugins/installed_plugins.json', 'ls -la ~/.local/bin', 'cat ~/.local/bin/zn',
    'which zn', 'zn --version', 'npm root -g', `ls ${pkg}/lib`]) {
    assert.equal(policy.bashDenial(cmd, { ...opts, cwd: project }), null, cmd);
  }
});

test('a long command with many uninstall words stays fast', (t) => {
  const { opts } = setup(t);
  const cmd = ('npm uninstall x ' + 'zn-gate '.repeat(1).trim() + ' ').repeat(2000).slice(0, 90000) + '; echo done';
  const t0 = Date.now();
  policy.bashDenial(cmd, opts);
  assert.ok(Date.now() - t0 < 5000);
  const noMatch = ('npm install zn-gate-x ').repeat(4000).slice(0, 90000);
  const t1 = Date.now();
  policy.bashDenial(noMatch, opts);
  assert.ok(Date.now() - t1 < 5000);
});

// ---- Through the Claude Code hook (the same policy runs for every adapter) ----

function pre(tool_name, tool_input, cwd) {
  return { session_id: 's', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't' };
}
async function decide(raw, home) {
  const out = await runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home });
  return out;
}
const blocked = (out) => !!(out && out.output && out.output.hookSpecificOutput && out.output.hookSpecificOutput.permissionDecision === 'deny');

test('the Claude Code hook denies Write, Edit, MultiEdit, NotebookEdit and Bash on zn\'s install', async (t) => {
  const { home, project } = setup(t);
  const plug = path.join(home, '.claude', 'plugins', 'cache', 'usezn', 'zn-gate', '1.13.1');
  const runnerJs = path.join(home, '.npm-global', 'lib', 'node_modules', 'zn-gate', 'lib', 'hooks', 'runner.js');
  const zn = path.join(home, '.local', 'bin', 'zn');
  const events = [
    ['Write', { file_path: path.join(plug, 'scripts', 'zn-launch.js'), content: 'process.exit(0)' }],
    ['Write', { file_path: runnerJs, content: 'process.exit(0);' }],
    ['Write', { file_path: zn, content: '#!/bin/sh\nexit 0\n' }],
    ['Edit', { file_path: path.join(plug, 'hooks', 'hooks.json'), old_string: 'a', new_string: 'b' }],
    ['Edit', { file_path: path.join(home, '.claude', 'plugins', 'installed_plugins.json'), old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: runnerJs, edits: [{ old_string: 'a', new_string: 'b' }] }],
    ['NotebookEdit', { notebook_path: path.join(home, '.claude', 'plugins', 'x.ipynb'), new_source: 'x' }],
    ['Bash', { command: 'npm uninstall -g zn-gate' }],
    ['Bash', { command: 'claude plugin marketplace remove usezn' }],
    ['Bash', { command: 'rm -rf ' + path.dirname(path.dirname(path.dirname(runnerJs))) }],
  ];
  for (const [tool, input] of events) {
    const out = await decide(pre(tool, input, project), home);
    assert.ok(blocked(out), tool + ' ' + JSON.stringify(input));
  }
  // allowed: a normal file, a normal command, reads
  for (const [tool, input] of [
    ['Write', { file_path: path.join(project, 'a.txt'), content: 'x' }],
    ['Read', { file_path: runnerJs }],
    ['Read', { file_path: path.join(home, '.claude', 'plugins', 'installed_plugins.json') }],
    ['Bash', { command: 'npm install -g other-package' }],
    ['Bash', { command: 'pip uninstall requests' }],
    ['Bash', { command: 'claude plugin list' }],
  ]) {
    const out = await decide(pre(tool, input, project), home);
    assert.ok(!blocked(out), tool + ' ' + JSON.stringify(input) + ' ' + JSON.stringify(out));
  }
});

test('the denial of a file names what is protected and asks the user', (t) => {
  const { home, opts } = setup(t);
  const msg = policy.writeDenial(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), opts);
  assert.match(msg, /^zn: the Claude Code plugin files \(/);
  assert.match(msg, /Ask the user to make this change/);
});
