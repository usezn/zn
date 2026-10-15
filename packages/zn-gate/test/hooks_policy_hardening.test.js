'use strict';

// Hardening after the beta review: a backslash is read both ways, letter case
// follows the platform (simulated here on any system), agent configuration
// directories cannot be changed by a command, glob matches are checked on the
// disk, and a render never writes agent settings and asks before credentials.
// Values are fake. The platform is restored after each simulated block.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const policy = require('../lib/hooks/policy');
const { createSecretsServer } = require('../lib/broker/mcp');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { generateAll } = require('./fixtures/fake_secrets');

const FAKE = generateAll(7171, { perType: 1, piiPerType: 1 });
const NPM = FAKE.secrets.find((s) => s.type === 'npm_access_token').value;
const AWS = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;

// Runs fn as if process.platform were `name`, then restores it.
function asPlatform(name, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: name, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', desc);
  }
}

// Every directory a test makes is removed when the tests of this file are done.
const created = [];
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-harden-'));
  created.push(home);
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  return { home, proj };
}

function call(srv, name, args) {
  return srv.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    .then((r) => ({ isError: r.result.isError, data: JSON.parse(r.result.content[0].text) }));
}

/* ------------------------------ both readings ------------------------------ */

test('a backslash before a letter is read both ways: a protected word is refused in either reading', () => {
  const { home, proj } = tmpHome();
  const opts = { home, cwd: proj, env: {} };
  // Bash reading: \e is e, so the word is .aws/credentials.
  assert.match(policy.bashDenial('cat ~/.aws/cr\\edentials', opts), /credential/);
  assert.match(policy.bashDenial('cat ~/.aws/credential\\s', opts), /credential/);
  // Windows reading (already covered): the backslashes are separators.
  assert.match(policy.bashDenial('type ' + path.join(home, '.aws', 'credentials'), opts), /credential/);
  // A .env file only counts when it holds a plain secret (a fake key here).
  fs.writeFileSync(path.join(proj, '.env'), 'KEY=' + AWS + '\n');
  assert.match(policy.bashDenial('cat .e\\nv', opts), /holds plain-text/);
  assert.equal(policy.bashDenial('cat src\\app.js', opts), null);
});

/* ------------------------------- platform case ------------------------------- */

test('case follows the platform: Azure token files and .env names match on Windows and macOS', () => {
  const { home, proj } = tmpHome();
  const opts = { home, cwd: proj, env: {} };
  fs.writeFileSync(path.join(proj, '.ENV'), 'PLAIN=1\n');
  asPlatform('darwin', () => {
    assert.equal(policy.classifyPath('~/.azure/accessTokens.json', opts).kind, 'credential');
    assert.equal(policy.classifyPath('~/.AZURE/ACCESSTOKENS.JSON', opts).kind, 'credential');
    assert.equal(policy.classifyPath('~/.azure/msal_token_cache.json', opts).kind, 'credential');
    assert.match(policy.bashDenial('cat ~/.azure/access*', opts), /credential/);
    assert.equal(policy.classifyPath('.ENV', opts).kind, 'dotenv');
    assert.equal(policy.classifyPath('.Env.Production', opts).kind, 'dotenv');
  });
  asPlatform('win32', () => {
    assert.equal(policy.classifyPath('~/.AZURE/accessTokens.JSON', opts).kind, 'credential');
  });
  asPlatform('linux', () => {
    assert.equal(policy.classifyPath('~/.AZURE/ACCESSTOKENS.JSON', opts), null, 'case kept on Linux');
    assert.equal(policy.classifyPath('.ENV', opts), null);
  });
});

/* ---------------------------- agent directories ---------------------------- */

test('a command cannot change an agent configuration directory, nor write into it', () => {
  const { home, proj } = tmpHome();
  const opts = { home, cwd: proj, env: {} };
  for (const cmd of [
    'cd ~/.claude && echo {} > settings.json',
    'rm -rf ~/.cursor',
    'mv ~/.codex /tmp/x',
    'find ~/.cursor -name hooks.json -delete',
    'tree -o ~/.claude/settings.json',
    'echo {} > $CODEX_HOME/hooks.json',
    'cp x.txt ' + path.join(proj, '.claude'),
  ]) {
    assert.match(policy.bashDenial(cmd, opts), /protected|configuration/, cmd);
  }
  for (const cmd of ['ls ~/.claude', 'cat ~/.claude/settings.json']) {
    assert.equal(policy.bashDenial(cmd, opts), null, cmd);
  }
});

test('the directories the environment names are agent configuration too', () => {
  const { home, proj } = tmpHome();
  const codexHome = path.join(home, 'codex-elsewhere');
  const opts = { home, cwd: proj, env: { CODEX_HOME: codexHome } };
  assert.match(policy.bashDenial('echo {} > ' + path.join(codexHome, 'hooks.json'), opts), /protected|configuration/);
  assert.match(policy.bashDenial('rm -rf ' + codexHome, opts), /protected|configuration/);
  assert.equal(policy.bashDenial('cat ' + path.join(home, 'notes.txt'), opts), null);
});

test('the directory named by CLAUDE_CONFIG_DIR is protected too, set or not', () => {
  const { home, proj } = tmpHome();
  const claudeDir = path.join(home, 'claude-elsewhere');
  const opts = { home, cwd: proj, env: { CLAUDE_CONFIG_DIR: claudeDir } };
  assert.match(policy.bashDenial('echo {} > ' + path.join(claudeDir, 'settings.json'), opts), /protected|configuration/);
  assert.match(policy.bashDenial('rm -rf ' + claudeDir, opts), /protected|configuration/);
  assert.match(policy.bashDenial('echo {} > $CLAUDE_CONFIG_DIR/settings.json', { home, cwd: proj, env: {} }), /protected|configuration/);
  assert.equal(policy.bashDenial('cat ' + path.join(claudeDir, 'settings.json'), opts), null, 'reading is allowed');
});

test('a PowerShell backtick is an escape: a word is refused with the backticks taken out', () => {
  const { home, proj } = tmpHome();
  const opts = { home, cwd: proj, env: {} };
  assert.match(policy.bashDenial('cat ~/.aws/cr`edentials', opts), /credential/);
  assert.match(policy.bashDenial('Get-Content ~/.aws/cred`entials', opts), /credential/);
  assert.equal(policy.bashDenial('Get-Content ' + path.join(proj, 'src', 'app.js'), opts), null);
});

test('the configuration roots (~/.config and XDG_CONFIG_HOME) cannot be removed or moved, but can be listed', () => {
  const { home, proj } = tmpHome();
  const xdg = path.join(home, 'xdg-elsewhere');
  const opts = { home, cwd: proj, env: { XDG_CONFIG_HOME: xdg } };
  assert.match(policy.bashDenial('rm -rf ~/.config', opts), /protected|configuration/);
  assert.match(policy.bashDenial('mv ~/.config /tmp/x', opts), /protected|configuration/);
  assert.match(policy.bashDenial('rm -r ' + xdg, opts), /protected|configuration/);
  assert.equal(policy.bashDenial('ls ~/.config', opts), null, 'listing is allowed');
  assert.equal(policy.bashDenial('rm -rf ~/.config/somebody-else', opts), null, 'only the root is protected');
});

/* ------------------------------ globs on disk ------------------------------ */

test('a glob is checked against the files that exist now, and a name starting with .env is a .env file', () => {
  const { home, proj } = tmpHome();
  const opts = { home, cwd: proj, env: {} };
  fs.writeFileSync(path.join(proj, '.env.production'), 'PLAIN=1\n');
  // Not a .env prefix and not in the example list: only the disk match names it.
  assert.match(policy.bashDenial('cat .en?.production', opts), /holds plain-text|credential|\.env/);
  // Starts with .env: refused whatever it matches.
  assert.match(policy.bashDenial('cat .env.nothing*', opts), /credential|holds plain-text|\.env/);
  // Named credential files, by pattern.
  assert.match(policy.bashDenial('cat ~/.config/gcloud/app*', opts), /credential/);
  assert.equal(policy.bashDenial('cat ~/Documents/*.pdf', opts), null);
});

/* --------------------------- render destinations --------------------------- */

test('secrets_render_file never writes agent settings, and asks before a credential file', async () => {
  const { home, proj } = tmpHome();
  fs.writeFileSync(path.join(proj, '.gitignore'), '.claude/\n.aws/\n*.rc\n');
  fs.writeFileSync(path.join(proj, 'npmrc.tpl'), 'token=__ZN_NPM_TOKEN__\n');
  spawnSync('git', ['init', '-q'], { cwd: proj });
  let answer = false;
  const vault = createFakeVault({ confirmFile: async () => answer });
  await vault.setSecret('NPM_TOKEN', NPM, { mode: 'file' });
  const srv = createSecretsServer({ vault, engine: fakeEngine, cwd: proj, home });

  const settings = await call(srv, 'secrets_render_file', { template: 'npmrc.tpl', out: '.claude/settings.local.json' });
  assert.equal(settings.isError, true);
  assert.match(settings.data.message, /agent hook or plugin configuration/);
  assert.ok(!fs.existsSync(path.join(proj, '.claude', 'settings.local.json')));

  const cred = await call(srv, 'secrets_render_file', { template: 'npmrc.tpl', out: '.aws/credentials' });
  assert.equal(cred.isError, true, 'declined: nothing written');
  assert.match(cred.data.message, /credential file/);
  assert.ok(!fs.existsSync(path.join(proj, '.aws', 'credentials')));
  assert.equal(vault.fileConfirmations[0].reason, 'the file is a credential file');

  answer = true;
  const yes = await call(srv, 'secrets_render_file', { template: 'npmrc.tpl', out: '.aws/credentials' });
  assert.equal(yes.isError, false, JSON.stringify(yes.data));
  assert.equal(fs.readFileSync(path.join(proj, '.aws', 'credentials'), 'utf8'), 'token=' + NPM + '\n');
});

test('an approved overwrite of a file with other hard links is refused, and the other name is untouched', { skip: process.platform === 'win32' }, async () => {
  const { home, proj } = tmpHome();
  fs.writeFileSync(path.join(proj, '.gitignore'), '*.rc\n');
  fs.writeFileSync(path.join(proj, 'npmrc.tpl'), 'token=__ZN_NPM_TOKEN__\n');
  spawnSync('git', ['init', '-q'], { cwd: proj });
  const a = path.join(proj, 'a.rc');
  const b = path.join(proj, 'b.rc');
  fs.writeFileSync(a, 'mine\n');
  fs.linkSync(a, b);
  const vault = createFakeVault({ confirmFile: async () => true });
  await vault.setSecret('NPM_TOKEN', NPM, { mode: 'file' });
  const srv = createSecretsServer({ vault, engine: fakeEngine, cwd: proj, home });
  const r = await call(srv, 'secrets_render_file', { template: 'npmrc.tpl', out: 'a.rc' });
  assert.equal(r.isError, true);
  assert.match(r.data.message, /hard links/);
  assert.equal(fs.readFileSync(b, 'utf8'), 'mine\n');
});

test('agent guard: versioned npm, npx and pnpm/bun launches of zn-gate are still admin commands', () => {
  const adminCommands = [
    'npx -y zn-gate@1.6.0 unlock',
    'npx zn-gate@latest hooks uninstall',
    'pnpm dlx zn-gate@1.6.0 env shadow .env',
    'bunx zn-gate@1.6.0 secret approve X',
    'npm exec zn-gate@1 -- hooks uninstall',
    'npm exec zn-gate@1 -- unlock',
    'npm x zn-gate@1 -- unlock',
    'npx -y zn-gate@1.6.0-beta.1 secret set DB_PASSWORD',
    'zn-gate@1.6.0 unlock',
  ];
  for (const cmd of adminCommands) {
    assert.ok(policy.bashDenial(cmd), 'expected a denial for: ' + cmd);
  }
  // An ordinary zn-gate command is not an admin command.
  assert.equal(policy.bashDenial('npx -y zn-gate@1.6.0 status'), null);
});

/* 1.8.0 review: zn admin commands written with a Windows path or .cmd. */
test('agent guard: zn admin commands with a Windows path or .cmd are refused', () => {
  const adminCommands = [
    'C:\\Users\\u\\AppData\\Roaming\\npm\\zn.cmd secret reveal X',
    '.\\zn.cmd secret get X',
    'zn.cmd hooks uninstall',
    'zn env unshadow',
    'zn-gate.cmd pins approve --all',
    'C:\\npm\\zn.cmd hooks uninstall',
    'C:\\Users\\u\\AppData\\Roaming\\npm\\zn.cmd env unshadow .env',
    'C:\\Users\\u\\AppData\\Roaming\\npm\\zn-gate.cmd pins approve --all',
    '& "C:\\Program Files\\nodejs\\zn.ps1" unlock',
    'node C:\\npm\\node_modules\\zn-gate\\bin\\cli.js secret set A',
  ];
  for (const cmd of adminCommands) {
    assert.ok(policy.bashDenial(cmd), 'expected a denial for: ' + cmd);
  }
  assert.match(policy.bashDenial('zn-gate.cmd pins approve --all'), /pins approve/);
  assert.equal(policy.adminCommand('C:\\npm\\zn.cmd secret reveal X'), 'secret reveal');
  // Ordinary commands and other programs whose name ends in zn are not admin commands.
  assert.equal(policy.bashDenial('C:\\npm\\zn.cmd status'), null);
  assert.equal(policy.adminCommand('C:\\tools\\myzn.cmd unlock'), null);
});

/* 1.8.0 review: commands over 100 KB are refused before any parsing. */
test('a shell command over 100 KB is refused at once; one just under the limit gets the normal check', () => {
  const cap = policy.SHELL_SCAN_CAP;
  assert.equal(cap, 100 * 1024);
  const tooLong = 'echo ' + 'a'.repeat(cap + 1 - 5);
  assert.equal(tooLong.length, cap + 1);
  const start = process.hrtime.bigint();
  const deny = policy.bashDenial(tooLong);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(deny, 'zn: this command is too long for zn to check (over 100 KB), so it was blocked. Next step: tell the user; do not resend it in parts.');
  assert.ok(ms < 50, 'took ' + ms + ' ms');
  // Exactly at the limit and just under it: the normal check runs.
  assert.equal(policy.bashDenial('echo ' + 'a'.repeat(cap - 5)), null);
  const head = 'cat ~/.aws/credentials ';
  const under = head + 'a'.repeat(cap - 1 - head.length);
  assert.equal(under.length, cap - 1);
  assert.match(policy.bashDenial(under), /credential/);
  // Normal commands are unchanged.
  assert.equal(policy.bashDenial('npm test'), null);
  assert.match(policy.bashDenial('cat ~/.aws/credentials'), /credential/);
});
