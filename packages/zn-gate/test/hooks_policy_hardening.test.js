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
const { budget } = require('./helpers/time_budget');

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

test('agent guard: the zn-gate uninstall command is an admin command, other uses of the word are not', () => {
  const adminCommands = [
    'zn uninstall',
    'zn-gate uninstall',
    'zn-gate uninstall --yes',
    'npx zn-gate uninstall',
    'npx -y zn-gate@1.14.0 uninstall --keep-vault',
    'npm exec zn-gate -- uninstall',
    'pnpm dlx zn-gate uninstall',
    'zn.cmd uninstall',
    'cd proj && zn uninstall',
  ];
  for (const cmd of adminCommands) {
    assert.ok(policy.bashDenial(cmd), 'expected a denial for: ' + cmd);
    assert.equal(policy.adminCommand(cmd), 'uninstall', cmd);
  }
  const fine = [
    'npm uninstall foo',
    'npm uninstall -g zn-gate',
    'pip uninstall zn-gate',
    'cat docs/uninstall.txt',
    'cat uninstall.txt',
    'grep uninstall README.md',
    'ls zn/uninstall.txt',
    'myzn uninstall',
  ];
  for (const cmd of fine) {
    assert.equal(policy.adminCommand(cmd), null, 'did not expect an admin command for: ' + cmd);
  }
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
  assert.ok(ms < budget(50), 'took ' + ms + ' ms');
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

test('a long command that repeats its words is checked quickly, and still blocks', () => {
  const t0 = process.hrtime.bigint();
  assert.equal(policy.bashDenial('echo ' + 'a '.repeat(40000)), null);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1500, 'too slow');
  assert.ok(policy.bashDenial('cat ' + 'README.md '.repeat(5000) + '~/.aws/credentials'));
});

test('a patch sent as a shell command (Codex apply_patch) is refused with the file it writes, not a glob word', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  const cmd = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: .env\n@@\n+EXAMPLE_DEBUG=1\n*** End Patch\nPATCH";
  const msg = policy.bashDenial(cmd, { cwd: dir, home: dir });
  assert.ok(msg, 'still refused');
  assert.match(msg, /this patch was blocked because it writes to \.env, which zn treats as holding secrets/);
  assert.doesNotMatch(msg, /\*\*\*/);
  // An ordinary command that names a glob and a literal secret file names the literal one.
  const m2 = policy.bashDenial('cat *.txt .env', { cwd: dir, home: dir });
  assert.match(m2, /\.env/);
  // A glob alone is still refused as before.
  assert.ok(policy.bashDenial('cat .e*', { cwd: dir, home: dir }));
  // A patch to an ordinary file sent as a shell command is still refused (its *** lines read as file patterns),
  // with a message that says why and what to do instead.
  const m3 = policy.bashDenial("apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: notes.txt\n+hello\n*** End Patch\nPATCH", { cwd: dir, home: dir });
  assert.match(m3, /sent as a shell command, which zn cannot check file by file/);
  assert.match(m3, /use the apply_patch tool/);
  // The file name is shown without control characters and cut short; a too-long command keeps its own message.
  const long = 'd'.repeat(300) + '/\u001b[2J/.env';
  const m4 = policy.bashDenial("apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: " + long + "\n@@\n+X=1\n*** End Patch\nPATCH", { cwd: dir, home: dir });
  assert.ok(m4 && m4.length < 400, String(m4 && m4.length));
  assert.doesNotMatch(m4, /\u001b/);
  const huge = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: a.txt\n+" + 'x'.repeat(policy.SHELL_SCAN_CAP + 10) + "\n*** End Patch\nPATCH";
  assert.doesNotMatch(policy.bashDenial(huge, { cwd: dir, home: dir }), /sent as a shell command/);
});

// The fastest of a few timed calls after one untimed call, so the cost of the first call (code compiled
// on demand, a cold cache) on a slow runner is not counted as the cost of the check.
function fastestMs(fn, runs = 5) {
  let result = fn();
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    result = fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return { ms: best, result };
}

// CPU time instead of wall-clock time, for a budget that a shared CI runner can break without any slower code: a stall
// while another job holds the core is wall-clock time the check never used. A check that backtracks burns CPU, so the
// budget still catches it. The CPU clock is coarse on Windows (about 16 ms), so the fastest of the runs is used.
function fastestCpuMs(fn, runs = 5) {
  let result = fn();
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const c0 = process.cpuUsage();
    result = fn();
    const c = process.cpuUsage(c0);
    best = Math.min(best, (c.user + c.system) / 1000);
  }
  return { ms: best, result };
}

test('a long patch sent as a shell command is refused quickly, naming a secret file among its first files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  let body = '';
  for (let i = 0; body.length < 90 * 1024; i++) body += '*** Add File: src/part' + i + '/file' + i + '.txt\n+x\n';
  const big = "apply_patch <<'PATCH'\n*** Begin Patch\n" + body + "*** End Patch\nPATCH";
  assert.ok(big.length < policy.SHELL_SCAN_CAP);
  const { ms, result: m } = fastestMs(() => policy.bashDenial(big, { cwd: dir, home: dir }));
  assert.ok(ms < budget(1500), 'too slow: ' + ms + ' ms');
  assert.match(m, /sent as a shell command, which zn cannot check file by file/);
  // A secret file among the first files is still named.
  const named = policy.bashDenial("apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: .env\n@@\n+X=1\n" + body + "*** End Patch\nPATCH", { cwd: dir, home: dir });
  assert.match(named, /writes to \.env/);
});

test('after a glob word, a command with many more words is still refused', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-gl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  const filler = Array.from({ length: 40 }, (_, i) => 'notes' + i + '.txt').join(' ');
  // The literal file comes after more words than zn resolves once a glob has refused the command.
  assert.ok(policy.bashDenial('cat .e* ' + filler + ' .env', { cwd: dir, home: dir }));
  assert.ok(policy.bashDenial('cat .e* ' + filler + ' ~/.zn/vault', { cwd: dir, home: dir }));
  // Within the first words the literal file is still the one named.
  assert.match(policy.bashDenial('cat .e* notes.txt .env', { cwd: dir, home: dir }), /\.env/);
});

test('a glob that names a .env file in a subfolder is refused, as the plain path is', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-globenv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'app1', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app1', 'inner', '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  fs.writeFileSync(path.join(dir, 'app1', 'inner', 'notes.txt'), 'hello\n');
  const o = { cwd: dir, home: dir };
  assert.ok(policy.bashDenial('cat app1/inner/.env', o), 'plain path');
  for (const cmd of ['cat app*/inner/.env', 'cat app1/*/.env', 'cat */inner/.env', 'cat a?p1/inner/.env', 'cat {app1,app2}/inner/.env', 'head -n 1 ./app1/*/.env']) {
    assert.ok(policy.bashDenial(cmd, o), cmd);
  }
  // An ordinary file reached the same way is still allowed.
  assert.equal(policy.bashDenial('cat app*/inner/notes.txt', o), null);
  assert.equal(policy.classifyWord('app*/inner/.env', o).kind, 'credential');
});

test('a .env file reached after a cd, through a path built at run time or from interpreter code is refused', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cdenv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'app1', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app1', 'inner', '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  fs.mkdirSync(path.join(dir, 'svc'));
  fs.writeFileSync(path.join(dir, 'svc', '.env'), 'EXAMPLE_API_KEY=__ZN_EXAMPLE_API_KEY__\n');
  const o = { cwd: dir, home: dir, env: {} };
  for (const cmd of [
    'cd app1/inner && cat .env',
    'cd app1 && cd inner && cat .env',
    'cd app1; cat inner/.env',
    'pushd app1/inner && cat .env',
    '(cd app1/inner && cat .env)',
    'cd "app1/inner" && head -n 1 .env',
    'cd $PROJ && cat .env',
    'cd - && cat .env',
    'cat $(echo app1)/inner/.env',
    'cat "$(echo app1)/inner/.env"',
    'D=app1/inner; cat $D/.env',
    'python3 -c "print(open(\'app1/inner/.env\').read())"',
    'node -e "console.log(require(\'fs\').readFileSync(\'app1/inner/.env\', \'utf8\'))"',
    'bash -c "cat app1/inner/.env"',
  ]) {
    assert.ok(policy.bashDenial(cmd, o), cmd);
  }
  for (const cmd of [
    'cd svc && cat .env',
    'cd app1 && npm test',
    'cd app1/inner && echo EXAMPLE_FLAG=1 >> .env',
    'cd app1/inner && cat .env.example',
    'cd /nonexistent && ls',
    'python3 -c "print(1)"',
    'cat .env',
  ]) {
    assert.equal(policy.bashDenial(cmd, o), null, cmd);
  }
});

test('a .env file named with bash $-quoting, a numbered input redirection or as name=value is refused', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-quoting-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  const o = { cwd: dir, home: dir, env: {} };
  for (const cmd of ["cat $'.env'", "cat $'\\x2eenv'", "cat $'\\56env'", "cat $'\\u002eenv'", "cat $'.e'nv", 'cat 0<.env', 'cat 3< .env', 'dd if=.env', 'ENV_FILE=.env docker compose up',
    "cat $'.env\\x00junk'", "cat $'.env\\0'", "cat $'.env\\c@x'", "cat $'.env\\u0000'", "cat $'.e\\0zz'nv",
    'cat $".env"', 'cat <>.env', 'cat 0<>.env', 'exec {fd}<.env; cat <&$fd']) {
    assert.ok(policy.bashDenial(cmd, o), cmd);
  }
  for (const cmd of ["echo $'hello\\n'", "printf $'%s\\t%s\\n' a b", 'dd if=/dev/zero of=out.bin count=1', 'make DEBUG=1']) {
    assert.equal(policy.bashDenial(cmd, o), null, cmd);
  }
  assert.equal(policy._decodeAnsiC("a $'\\x41\\102\\'c' z"), "a 'AB'\\''c' z");
});

test('after a cd, only the folders the command can reach are checked, also when the current .env is shadowed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cdenv2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'app1', 'inner'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'app', 'app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_API_KEY=__ZN_EXAMPLE_API_KEY__\n');
  fs.writeFileSync(path.join(dir, 'app1', 'inner', '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  // A folder the command never reaches (app/app) holds values.
  fs.writeFileSync(path.join(dir, 'app', 'app', '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  const o = { cwd: dir, home: dir, env: { PWD: dir } };
  for (const cmd of [
    'cd app1/inner && cat .env',
    'cd app1/inner && cat $PWD/.env',
    '{ cd app1/inner; cat .env; }',
    'if cd app1/inner; then cat .env; fi',
    'bash -c "cd app1/inner && cat .env"',
    'cd $PROJ && cat .env',
  ]) {
    assert.ok(policy.bashDenial(cmd, o), cmd);
  }
  assert.match(policy.bashDenial('cd app1/inner && cat .env', o), /changes to app1\/inner first/);
  for (const cmd of [
    'cat .env',
    'cd app && cat .env',
    'cd a && cd b && cat d1/.env',
    'echo $(date) && cat .env',
    'cd app1 && npm test',
  ]) {
    assert.equal(policy.bashDenial(cmd, o), null, cmd);
  }
});

test('a .env or credential file read from the git repository is refused', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-gitobj-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const o = { cwd: dir, home: dir, env: {} };
  for (const cmd of ['git show HEAD:.env', 'git show :.env', 'git show :0:.env', 'git cat-file -p HEAD:.env', 'git -C app1 show HEAD:.env',
    'git show HEAD~1:app1/inner/.env', 'git show main:./.env.local', 'git show HEAD:.aws/credentials', 'git cat-file blob v1.0:config/.env']) {
    assert.ok(policy.bashDenial(cmd, o), cmd);
  }
  for (const cmd of ['git show HEAD:README.md', 'git show HEAD:.env.example', 'git log --oneline', 'git show HEAD',
    'git push origin main:main', 'git fetch https://example.com/repo.git', 'git diff HEAD:src/a.js HEAD~1:src/a.js']) {
    assert.equal(policy.bashDenial(cmd, o), null, cmd);
  }
});

test('the history of a .env file is refused even when the file is gone from disk', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-githist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const o = { cwd: dir, home: dir, env: {} };
  for (const cmd of ['git log -p -- .env', 'git show HEAD -- .env', 'git diff HEAD~1 -- .env', 'git grep -h KEY HEAD -- .env',
    'git archive HEAD .env | tar x -O', 'git checkout HEAD -- .env', 'git restore --source=HEAD -- .env', 'git -C app -c core.pager=cat log -p app/.env',
    'git.exe show HEAD:.env', 'git show "HEAD:' + './'.repeat(700) + '.env"', 'git show ' + 'HEAD~1'.repeat(100) + ':.env']) {
    assert.ok(policy.bashDenial(cmd, o), cmd.slice(0, 80));
  }
  for (const cmd of ['git rm --cached .env', 'git status', 'git check-ignore .env', 'git add .gitignore', 'git log --oneline',
    'git commit -m "stop tracking .env"', 'git show HEAD:.env.example']) {
    assert.equal(policy.bashDenial(cmd, o), null, cmd);
  }
});

test('git steps that only clean up a tracked .env stay allowed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-gitclean-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const o = { cwd: dir, home: dir, env: {} };
  for (const cmd of ['git restore --staged .env', 'git checkout -- .env', 'git restore .env', 'git stash push -- .env',
    'git diff --stat -- .env', 'git log --oneline -- .env', 'git log --name-only -- .env', 'git show --stat HEAD -- .env']) {
    assert.equal(policy.bashDenial(cmd, o), null, cmd);
  }
  for (const cmd of ['git restore --source=HEAD~1 .env', 'git restore -s HEAD .env', 'git checkout HEAD -- .env', 'git checkout main .env',
    'git stash show -p -- .env', 'git log --oneline -p -- .env', 'git log --stat -p -- .env', 'git diff -- .env',
    'git log --oneline --patch-with-stat -- .env', 'git log --stat --patch-with-raw -- .env', 'git log --stat -U3 -- .env',
    'git log --stat --unified=1 -- .env', 'git diff --stat --binary HEAD~1 -- .env', 'git show --oneline HEAD -- .env', 'git restore -sHEAD .env', 'git log -L1,5:.env']) {
    assert.ok(policy.bashDenial(cmd, o), cmd);
  }
});

test('a private key kept in the project is refused; a certificate or public key is not', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-keys-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'deploy'));
  // Fake, obviously invalid key material: only the markers matter.
  const fakeKey = '-----BEGIN PRIVATE KEY-----\nZN-TEST-FAKE-KEY-NOT-REAL\n-----END PRIVATE KEY-----\n';
  fs.writeFileSync(path.join(dir, 'deploy', 'server.key'), fakeKey);
  fs.writeFileSync(path.join(dir, 'deploy', 'tls.pem'), fakeKey.replace(/PRIVATE KEY/g, 'RSA PRIVATE KEY'));
  fs.writeFileSync(path.join(dir, 'deploy', 'cert.pem'), '-----BEGIN CERTIFICATE-----\nZN-TEST-FAKE-CERT\n-----END CERTIFICATE-----\n');
  fs.writeFileSync(path.join(dir, 'deploy', 'id_ed25519'), 'ZN-TEST-FAKE\n');
  fs.writeFileSync(path.join(dir, 'deploy', 'id_ed25519.pub'), 'ssh-ed25519 ZN-TEST-FAKE\n');
  const o = { cwd: dir, home: dir, env: {} };
  for (const cmd of ['cat deploy/server.key', 'cat deploy/tls.pem', 'cat deploy/id_ed25519', 'base64 deploy/server.key', 'cat deploy/store.p12']) {
    assert.ok(policy.bashDenial(cmd, o), cmd);
  }
  for (const cmd of ['cat deploy/cert.pem', 'openssl x509 -in deploy/cert.pem -noout -text', 'cat deploy/id_ed25519.pub', 'cat deploy/missing.key']) {
    assert.equal(policy.bashDenial(cmd, o), null, cmd);
  }
  assert.ok(policy.readDenial(path.join(dir, 'deploy', 'server.key'), o));
  assert.equal(policy.readDenial(path.join(dir, 'deploy', 'cert.pem'), o), null);
});

test('reading a key or .env file never blocks and a repeated word is read once', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-keys-perf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'cert.pem'), '-----BEGIN CERTIFICATE-----\n' + 'A'.repeat(1024 * 1024) + '\n-----END CERTIFICATE-----\n');
  fs.writeFileSync(path.join(dir, 'pgp.key'), '-----BEGIN PGP PRIVATE KEY BLOCK-----\nZN-TEST-FAKE\n-----END PGP PRIVATE KEY BLOCK-----\n');
  fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  const o = { cwd: dir, home: dir, env: {} };
  const t0 = process.hrtime.bigint();
  assert.ok(policy.bashDenial('cat cert.pem '.repeat(7000) + '; cat .env', o), 'still reaches the .env');
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 5000, 'too slow');
  assert.ok(policy.bashDenial('cat pgp.key', o));
  if (process.platform !== 'win32') {
    const { execFileSync } = require('child_process');
    execFileSync('mkfifo', [path.join(dir, 'pipe.pem'), path.join(dir, 'pipe.env')]);
    fs.renameSync(path.join(dir, 'pipe.env'), path.join(dir, '.env.pipe'));
    const t1 = process.hrtime.bigint();
    assert.ok(policy.bashDenial('cat pipe.pem', o), 'a FIFO named .pem is refused without being read');
    assert.ok(policy.bashDenial('cat .env.pipe', o), 'a FIFO named .env.* is refused without being read');
    assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 2000, 'a FIFO must not block');
  }
});

test('a command with many paths after several cd is refused within the time budget, never let through', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-budget-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const d of ['a', 'b', 'c', 'd']) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  const o = { cwd: dir, home: dir, env: {} };
  // A few simple commands, so the 1000-command limit is not what stops it: one cat with thousands of paths.
  let cmd = 'cd a; cd b; cd c; cd d; cat';
  for (let i = 0; cmd.length < 98000; i++) cmd += ' x' + i + '/.env';
  cmd += '; cat .env';
  const t0 = process.hrtime.bigint();
  const deny = policy.bashDenial(cmd, o);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(deny, 'refused');
  assert.match(deny, /too many paths|holds plain-text secrets/);
  assert.ok(ms < budget(8000), 'checked in ' + ms + ' ms');
});

test('a Python virtualenv named .env is a folder, not a secret file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-venv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.env', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.env', 'bin', 'activate'), '# fake activate\n');
  const o = { cwd: dir, home: dir, env: {} };
  for (const cmd of ['ls .env', 'rm -rf .env', 'python3 -m venv .env', 'source .env/bin/activate']) {
    assert.equal(policy.bashDenial(cmd, o), null, cmd);
  }
  assert.equal(policy.readDenial(path.join(dir, '.env'), o), null);
});

test('a read placed after thousands of chained commands is still found, and a long heredoc is fine', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-chain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.aws'));
  fs.writeFileSync(path.join(dir, '.aws', 'credentials'), '[default]\n');
  const o = { cwd: dir, home: dir, env: {} };
  for (const n of [999, 1001, 5000, 16000]) {
    assert.ok(policy.bashDenial('true; '.repeat(n) + 'cat ~/.aws/credentials', o), String(n));
  }
  assert.equal(policy.bashDenial('true; '.repeat(1500) + 'ls', o), null);
  const heredoc = "cat > out.py <<'EOF'\n" + Array.from({ length: 1200 }, (_, i) => 'x' + i + ' = ' + i).join('\n') + '\nEOF';
  assert.equal(policy.bashDenial(heredoc, o), null, 'a 1200-line heredoc writing a file');
});

/* ------------------- here-document bodies read as data ------------------- */

test('the body of a here-document a program reads as data is not refused for a glob or a path in it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-heredoc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  fs.mkdirSync(path.join(dir, '.aws'));
  fs.writeFileSync(path.join(dir, '.aws', 'credentials'), '[default]\n');
  const o = { cwd: dir, home: dir, env: {} };
  // Code with a glob, brackets, braces and secret-looking paths, written to a file: all data.
  let body = '';
  for (let i = 0; body.length < 90 * 1024; i++) body += 'const v' + i + ' = a[' + i + '] * b; // .env ~/.aws/credentials "quoted"\n';
  const cmd = (head, tail) => head + '\n' + body + tail;
  assert.equal(policy.bashDenial(cmd("cat > generated.js <<'EOF'", 'EOF'), o), null, 'quoted delimiter');
  assert.equal(policy.bashDenial(cmd('cat > generated.js <<EOF', 'EOF'), o), null, 'bare delimiter');
  assert.equal(policy.bashDenial(cmd('tee generated.js <<"EOF"', 'EOF'), o), null, 'double-quoted delimiter');
  assert.equal(policy.bashDenial(cmd("dd of=generated.js <<'EOF'", 'EOF'), o), null, 'dd');
  assert.equal(policy.bashDenial(cmd('cat > generated.js <<-EOF', '\tEOF'), o), null, '<<- strips tabs');
  assert.equal(policy.bashDenial(cmd('cat > generated.js <<\\EOF', 'EOF'), o), null, 'backslash-quoted delimiter');
  assert.equal(policy.bashDenial(cmd("sudo tee /tmp/generated.js <<'EOF'", 'EOF'), o), null, 'behind a wrapper');
  // Two here-documents on one line: each body ends at its own delimiter.
  assert.equal(policy.bashDenial("cat <<'A' <<'B'\n* ? [a-z]\nA\n{ }\nB", o), null, 'two bodies on one line');
  // A program run before the command does not make the body code: only what runs
  // after the operator can run it, so a program or a relative path before it is
  // not a reason to keep the check.
  assert.equal(policy.bashDenial("python3 build.py && cat > generated.js <<'EOF'\n* .env ~/.aws/credentials\nEOF", o), null, 'a program before the here-document');
  assert.equal(policy.bashDenial("mkdir -p ./out && tee ./out/generated.js <<'EOF'\n* .env\nEOF", o), null, 'a relative path before the here-document');
  // A redirect after the operator names the file the body is written to: its
  // target is not a command, so the body stays data.
  assert.equal(policy.bashDenial("cat <<'EOF' > generated.js\n* .env ~/.aws/credentials\nEOF", o), null, 'a relative redirect target after the operator');
  assert.equal(policy.bashDenial("cat <<'EOF' > " + path.join(dir, 'generated.js') + "\n* .env\nEOF", o), null, 'an absolute redirect target after the operator');
});

test('a here-document that runs its body as code, or a read on the command line, is still refused', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-heredoc-deny-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  fs.mkdirSync(path.join(dir, '.aws'));
  fs.writeFileSync(path.join(dir, '.aws', 'credentials'), '[default]\n');
  const o = { cwd: dir, home: dir, env: {} };
  const body = Array.from({ length: 2000 }, (_, i) => 'line ' + i).join('\n');
  // The read stays on the command line, before or after the here-document.
  assert.ok(policy.bashDenial("cat .env <<'EOF'\n" + body + '\nEOF', o), 'read before the here-document');
  assert.ok(policy.bashDenial("cat <<'EOF'\n" + body + '\nEOF\ncat .env', o), 'read after the here-document');
  // A bare delimiter expands the body, so a substitution in it still reads the file.
  assert.ok(policy.bashDenial('cat > out.txt <<EOF\n$(cat .env)\nEOF', o), 'command substitution');
  assert.ok(policy.bashDenial('cat > out.txt <<EOF\n`cat .aws/credentials`\nEOF', o), 'backticks');
  assert.ok(policy.bashDenial('cat > out.txt <<EOF\n$(cat .env)\n' + body, o), 'unterminated body');
  // A shell, an interpreter or apply_patch runs the body as code, so it keeps its check.
  assert.ok(policy.bashDenial("bash <<'EOF'\ncat .env\nEOF", o), 'bash reads code from stdin');
  assert.ok(policy.bashDenial("sudo bash <<EOF\ncat .aws/credentials\nEOF", o), 'bash behind a wrapper');
  assert.ok(policy.bashDenial("python3 - <<'PY'\nopen('.env').read()\nPY", o), 'python reads code from stdin');
  // A body the command pipes somewhere, groups, or feeds to xargs is not data either.
  assert.ok(policy.bashDenial("cat <<'EOF' | sh\ncat .env\nEOF", o), 'piped to a shell');
  assert.ok(policy.bashDenial("dd <<'EOF' | sh\ncat .env\nEOF", o), 'piped to a shell after dd');
  assert.ok(policy.bashDenial("tee >(sh) <<'EOF'\ncat .env\nEOF", o), 'process substitution');
  assert.ok(policy.bashDenial('( sh ) <<EOF\ncat .env\nEOF', o), 'group close before the operator');
  assert.ok(policy.bashDenial('{ sh; } <<EOF\ncat .env\nEOF', o), 'brace group before the operator');
  assert.ok(policy.bashDenial('<<EOF sh\ncat .env\nEOF', o), 'operator before the program');
  assert.ok(policy.bashDenial("xargs cat <<'EOF'\n.env\nEOF", o), 'xargs turns its input into a command');
  // A command that writes a script and then runs it keeps the old check.
  for (const run of ['bash x.sh', 'sh x.sh', 'source x.sh', './x.sh']) {
    assert.ok(policy.bashDenial("cat > x.sh <<'EOF'\ncat .env\nEOF\n" + run, o), 'written and run: ' + run);
  }
  // A pipe or a process substitution before the operator makes the command a
  // pipeline, not a plain simple data command: the body keeps the check.
  assert.ok(policy.bashDenial("echo hi | cat <<'EOF'\ncat .env\nEOF", o), 'pipe before the here-document');
  assert.ok(policy.bashDenial("cat <(sh) <<'EOF'\ncat .env\nEOF", o), 'input process substitution before the here-document');
  assert.ok(policy.bashDenial("tee >(sh) cat <<'EOF'\ncat .env\nEOF", o), 'output process substitution before the program');
  // A script the same command writes and then runs by another route keeps the check.
  assert.ok(policy.bashDenial("cat > x.sh <<'EOF'\ncat .env\nEOF\n. x.sh", o), 'written and sourced with dot');
  assert.ok(policy.bashDenial("cat > x.sh <<'EOF'\ncat .env\nEOF\ncat x.sh | sh", o), 'written then piped to a shell');
  // A group opened on an earlier line counts, also when the closing line pipes
  // the body to a program that runs its input (awk, sed).
  assert.ok(policy.bashDenial("{\ncat <<'EOF'\ncat .env\nEOF\n} | awk '{system($0)}'", o), 'a group opened on an earlier line, piped to awk');
  assert.ok(policy.bashDenial("(\ncat <<'EOF'\ncat .env\nEOF\n) | sed e", o), 'a substitution opened on an earlier line, piped to sed');
  // The `)` of a `case` pattern does not close an open group: the body stays
  // code when the group is piped to a program that runs its input.
  assert.ok(policy.bashDenial("{ case x in a) ;; esac\ncat <<'EOF'\ncat .env\nEOF\n} | awk '{system($0)}'", o), 'a case-pattern paren inside a group piped to awk');
  // A pipe after the first data body keeps the check: a group or a substitution
  // opened on an earlier line can run it and the walk cannot tell a `case`
  // pattern from a group close.
  assert.ok(policy.bashDenial("( case x in a) ;; esac\ncat <<'EOF'\ncat .env\nEOF\n) | awk '{system($0)}'", o), 'a case-pattern paren in a subshell piped to awk');
  assert.ok(policy.bashDenial("( case x in a) ;; esac\ncat <<'EOF'\ncat .env\nEOF\n) | sed e", o), 'a case-pattern paren in a subshell piped to sed');
  assert.ok(policy.bashDenial("y=$( case x in a) ;; esac\ncat <<'EOF'\ncat .env\nEOF\n| awk '{system($0)}')", o), 'a case-pattern paren in a command substitution piped to awk');
  // A data program with an option that runs a program is not a plain data program.
  assert.ok(policy.bashDenial("split -n 1 --filter=sh <<'EOF'\ncat .env\nEOF", o), 'split with a filter program');
  assert.ok(policy.bashDenial("sort -S 1 --compress-program=sh <<'EOF'\ncat .env\nEOF", o), 'sort with a compress program');
  // A command that redefines how a name resolves keeps the check on its bodies.
  assert.ok(policy.bashDenial("cat() { sh; }; cat <<'EOF'\ncat .env\nEOF", o), 'a function redefines the data program');
  assert.ok(policy.bashDenial("alias cat=sh; cat <<'EOF'\ncat .env\nEOF", o), 'the command sets an alias');
  assert.ok(policy.bashDenial("cat > f <<'EOF'\ncat .env\nEOF\nPATH=. cat </dev/null", o), 'the command changes PATH');
  // A file the same command writes and then runs by an absolute path keeps the check.
  const abs = path.join(dir, 'x.sh');
  assert.ok(policy.bashDenial("cat > " + abs + " <<'EOF'\ncat .env\nEOF\nchmod +x " + abs + '; ' + abs, o), 'written and run by an absolute path');
  // Also behind a wrapper: the wrapper is skipped before the command is read.
  for (const run of ['nohup ' + abs, 'timeout 5 ' + abs, 'exec ' + abs, 'sudo ' + abs]) {
    assert.ok(policy.bashDenial("cat > " + abs + " <<'EOF'\ncat .env\nEOF\n" + run, o), 'written and run behind a wrapper: ' + run);
  }
  // A file written from a body and only read as an argument is not run: the body stays data.
  assert.equal(policy.bashDenial("cat > out.txt <<'EOF'\n* .env\nEOF\ngrep x out.txt", o), null, 'written and only read as an argument');
  // A quoted delimiter turns the expansions off: the same text is data.
  assert.equal(policy.bashDenial("cat > out.txt <<'EOF'\n$(cat .env)\nEOF", o), null, 'quoted: data');
  // A comment that spells a here-document does not eat the command after it.
  assert.ok(policy.bashDenial('# example: cat <<EOF\ncat .env', o), 'comment');
  // `<<` in arithmetic is a shift, not a here-document.
  assert.ok(policy.bashDenial('echo $(( 1 <<2 ))\ncat .env\n2', o), 'arithmetic shift');
  // A glob on the command line itself is still refused.
  assert.ok(policy.bashDenial('cat *', o), 'glob on the command line');
});

test('a 100 KB here-document read as data is checked in milliseconds', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-heredoc-big-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const o = { cwd: dir, home: dir, env: {} };
  const line = 'export const value = a * b + 1; // 100 KB of code written to a file\n';
  let body = '';
  while (body.length + line.length < 100 * 1024 - 64) body += line;
  const cmd = "cat > generated.js <<'EOF'\n" + body + 'EOF';
  const { ms, result: deny } = fastestCpuMs(() => policy.bashDenial(cmd, o));
  assert.equal(deny, null, 'the body is data, so the command is allowed');
  assert.ok(ms < budget(25), 'checked in ' + ms + ' ms');
});

test('10 000 here-document operators on one line are checked within the time budget', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-heredoc-many-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const o = { cwd: dir, home: dir, env: {} };
  const cmd = 'cat ' + "<<'D' ".repeat(10000);
  assert.ok(cmd.length < policy.SHELL_SCAN_CAP, 'the case is under the scan cap');
  const t0 = process.hrtime.bigint();
  const deny = policy.bashDenial(cmd, o);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(deny, null, 'the bodies are data, so the command is allowed');
  assert.ok(ms < budget(1500), 'checked in ' + ms + ' ms');
});

test('50 000 parentheses on one line are checked within the time budget', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-heredoc-parens-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const o = { cwd: dir, home: dir, env: {} };
  // 25 000 `((` runs on the operator line: an unclosed arithmetic run must be
  // read once, not rescanned for every `(`, or the check becomes quadratic.
  const cmd = 'cat <<a ' + '(('.repeat(25000) + 'x\nb\na';
  assert.ok(cmd.length < policy.SHELL_SCAN_CAP, 'the case is under the scan cap');
  const t0 = process.hrtime.bigint();
  policy.bashDenial(cmd, o);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < budget(1500), 'checked in ' + ms + ' ms');
});

test('thousands of cd in one command are followed within the time budget', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-manycd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_API_KEY=__ZN_EXAMPLE_API_KEY__\n');
  const o = { cwd: dir, home: dir, env: {} };
  for (const unit of ['cd x; ', 'cd x/y/z; ', "(cd a;$'b'); ", 'cd a;cd b; ']) {
    const cmd = unit.repeat(Math.floor(98000 / unit.length)) + 'cat .env';
    const t0 = process.hrtime.bigint();
    const deny = policy.bashDenial(cmd, o);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(deny, unit + ': a .env read after cd it cannot follow is refused');
    assert.ok(ms < budget(5000), unit + ' took ' + ms + ' ms');
  }
});

/* ------------------- key files: globs, cd, git objects, git wrappers ------------------- */

const FAKE_KEY = '-----BEGIN PRIVATE KEY-----\nZN-TEST-FAKE-KEY\n-----END PRIVATE KEY-----\n';
const FAKE_CERT = '-----BEGIN CERTIFICATE-----\nZN-TEST-FAKE-CERT\n-----END CERTIFICATE-----\n';

function keyDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'certs'));
  fs.writeFileSync(path.join(dir, 'certs', 'server.key'), FAKE_KEY);
  fs.writeFileSync(path.join(dir, 'certs', 'cert.pem'), FAKE_CERT);
  fs.writeFileSync(path.join(dir, 'certs', 'ca.crt'), FAKE_CERT);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  return { dir, o: { cwd: dir, home: dir, env: {} } };
}

test('a glob that matches a private key file is refused, one that matches only certificates is allowed', (t) => {
  const { dir, o } = keyDir(t, 'zn-keyglob-');
  fs.mkdirSync(path.join(dir, 'pub'));
  fs.writeFileSync(path.join(dir, 'pub', 'a.pem'), FAKE_CERT);
  fs.writeFileSync(path.join(dir, 'pub', 'b.key'), FAKE_CERT);
  for (const cmd of ['cat certs/*.key', 'cat certs/*', 'cat certs/server.*', 'cat certs/*.[pk]*', 'cat certs/{server,x}.key', 'cat "certs/"*.key',
    'cat ./certs/s?rver.key', 'head -n1 certs/*.key', 'cat certs/*.pem certs/*.key']) {
    assert.match(policy.bashDenial(cmd, o) || '', /private key file|too broad/, cmd);
  }
  for (const cmd of ['cat certs/*.crt', 'cat certs/cert.pem', 'cat pub/*.pem', 'cat pub/*', 'cat pub/*.key', 'cat nothing/*.key']) {
    assert.equal(policy.bashDenial(cmd, o), null, cmd);
  }
});

test('a key file read after cd is found in the folder the cd leads to, and an unknown cd refuses the read', (t) => {
  const { o } = keyDir(t, 'zn-keycd-');
  for (const cmd of ['cd certs && cat server.key', 'cd certs; cat server.key', 'cd certs && cat *.key', 'pushd certs && cat server.key',
    '(cd certs && cat server.key)', 'cd $SOMEWHERE && cat server.key', 'cd - && cat server.key', 'cd $(pwd)/certs && cat server.key']) {
    assert.ok(policy.bashDenial(cmd, o), cmd);
  }
  for (const cmd of ['cd certs && cat cert.pem', 'cd certs && openssl x509 -in cert.pem -noout -text', 'cat certs/cert.pem', 'cd certs && ls']) {
    assert.equal(policy.bashDenial(cmd, o), null, cmd);
  }
});

test('a key file or a certificate read from the git repository or its history is refused like a .env', (t) => {
  const { o } = keyDir(t, 'zn-keygit-');
  for (const cmd of ['git show HEAD:certs/server.pem', 'git show HEAD:certs/server.key', 'git cat-file -p HEAD:certs/cert.pem', 'git log -p -- server.key',
    'git diff HEAD~1 -- certs/server.key', 'git checkout HEAD -- certs/server.key', 'git show :0:certs/server.key']) {
    assert.match(policy.bashDenial(cmd, o) || '', /git/, cmd);
  }
  for (const cmd of ['git show HEAD:README.md', 'git log --oneline -- old/gone.key', 'git status', 'git add old/gone.key', 'git check-ignore old/gone.key', 'git rm --cached old/gone.key']) {
    assert.equal(policy.bashDenial(cmd, o), null, cmd);
  }
});

test('git behind sudo, env, command, nohup or xargs is read like git, and a git object word is refused anywhere in a command with git', (t) => {
  const { o } = keyDir(t, 'zn-gitwrap-');
  for (const cmd of ['sudo git show HEAD:.env', 'sudo -u root git show HEAD:.env', 'env git show HEAD:.env', 'env FOO=1 git show HEAD:.env', 'command git show HEAD:.env',
    'nohup git show HEAD:.env', 'time git show HEAD:.env', 'xargs git show <<< HEAD:.env', 'echo HEAD:.env | xargs git show', 'echo HEAD:certs/server.key | xargs -n1 git show',
    'sudo git log -p -- .env', 'env git log -p -- certs/server.key', '/usr/bin/git show HEAD:.env', 'git show HEAD:.env', "sh -c 'git show HEAD:.env'",
    "git show ':(top).env'", "git show ':/.env'", "git show ':(glob)**/.env'", "git show ':(top,glob)**/.env'", "git log -p -- ':(top).env'"]) {
    assert.ok(policy.bashDenial(cmd, o), cmd);
  }
  for (const cmd of ['git show HEAD:README.md', 'sudo apt install git', 'xargs grep x', 'echo HEAD:README.md | xargs git show', 'sudo git status', 'env git log --oneline',
    'xargs -n1 echo', "git show ':(top)README.md'", 'echo hello: world', 'command -v git', 'git log -p -- README.md']) {
    assert.equal(policy.bashDenial(cmd, o), null, cmd);
  }
});

test('many distinct key file globs and words after several cd are decided within the time budget', (t) => {
  const { dir, o } = keyDir(t, 'zn-keybudget-');
  for (const d of ['a', 'b', 'c', 'd']) fs.mkdirSync(path.join(dir, d));
  for (const shape of ['glob', 'word']) {
    let cmd = 'cd a; cd b; cd c; cd d; cat';
    for (let i = 0; cmd.length < 98000; i++) cmd += shape === 'glob' ? ' x' + i + '/*.key' : ' k' + i + '.key';
    cmd += '; cat certs/server.key';
    const t0 = process.hrtime.bigint();
    const deny = policy.bashDenial(cmd, o);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(deny, shape + ': refused');
    assert.ok(ms < budget(5000), shape + ' took ' + ms + ' ms');
  }
});

test('git behind wrappers with flags, unknown wrappers or odd chains is still read as git, with the file gone from disk', (t) => {
  const { o } = keyDir(t, 'zn-gitwrap2-');
  for (const cmd of ['sudo -n git log -p -- .env', 'sudo -E git log -p -- old/server.key', 'sudo -s git log -p -- .env', 'sudo -En git log -p -- .env',
    'sudo -u root -E git log -p -- .env', 'sudo -k git log -p -- .env', 'time -p git log -p -- .env', 'nice -n 5 git log -p -- .env',
    'ionice -c 3 git log -p -- .env', 'stdbuf -o L git log -p -- .env', 'chrt -b 0 git log -p -- .env', 'taskset 0x1 git log -p -- .env',
    'flock /x.lock git log -p -- .env', 'timeout -s KILL 5 git log -p -- .env', 'env -i git log -p -- .env',
    'xargs -I{} git show {} <<< HEAD:.env', 'xargs -n 1 git log -p -- .env', 'sudo -n env -i git show HEAD:.env', 'exec -a x git show HEAD:.env']) {
    assert.ok(policy.bashDenial(cmd, o), cmd);
  }
  for (const cmd of ['sudo apt-get install git-lfs', 'time npm test', 'xargs grep x', 'sudo -n true', 'sudo -E env', 'ionice -c 3 ls', 'flock /x.lock ls',
    'sudo -n git status', 'sudo -E git log --oneline -- old/gone.key', 'chrt -b 0 ls', 'taskset 0x1 true', 'time -p ls']) {
    assert.equal(policy.bashDenial(cmd, o), null, cmd);
  }
});

test('git run by the code of a shell (sh -c, bash -lc, flock -c, env -S, Start-Process) is read as git, with the file gone from disk', (t) => {
  const { o } = keyDir(t, 'zn-shellcode-');
  for (const cmd of ['sh -c "git log -p -- .env"', "bash -c 'git log -p -- .env'", 'bash -lc "git log -p -- .env"', 'sudo sh -c "git log -p -- .env"',
    'flock /x.lock -c "git log -p -- .env"', 'flock -c "git log -p -- .env" /x.lock', 'env -S "git log -p -- .env"', 'env --split-string="git log -p -- .env"',
    'zsh -c "git show HEAD:.env"', 'dash -c "git log -p -- old/server.key"', 'pwsh -Command "git log -p -- .env"', 'powershell -c "git log -p -- .env"',
    'cmd /c "git log -p -- .env"', 'Start-Process git -ArgumentList "log -p -- .env"', "Start-Process git -ArgumentList 'log','-p','--','.env'",
    "bash -c \"sh -c 'git log -p -- .env'\"", 'sh -c "sudo -n git log -p -- .env"', 'sh -c "cat certs/server.key"',
    'su -c "git log -p -- .env"', 'su - app -c "git log -p -- .env"', 'busybox sh -c "git log -p -- .env"', 'xargs sh -c "git log -p -- .env"',
    'eval "git log -p -- .env"', 'watch -n 5 "git log -p -- .env"', 'watch "git log -p -- .env"', 'bash -xc "git log -p -- .env"', 'bash -o pipefail -c "git log -p -- .env"',
    'sudo -n bash -ec "git log -p -- .env"', 'pwsh -NoProfile -Command git log -p -- .env', 'pwsh -EncodedCommand ' + Buffer.from('git log -p -- .env', 'utf16le').toString('base64'),
    'cmd /c git log -p -- .env', 'env -i sh -c "git log -p -- .env"']) {
    assert.ok(policy.bashDenial(cmd, o), cmd);
  }
  for (const cmd of ['bash -c "npm test"', 'sh -c "git status"', 'bash -c "echo .env"', 'sh -c "git log --oneline -- old/gone.key"', 'bash -lc "ls"',
    'Start-Process git -ArgumentList "status"', 'cmd /c dir', 'env -S "ls -l"', "bash -c \"sh -c 'echo hi'\"", 'grep -c foo README.md',
    'psql -c "SELECT * FROM users"', 'psql -c "select count(*) from t"', 'docker exec db psql -U app -c "select * from t limit 5"',
    'grep -c "source .env" README.md', 'grep -rc "cat .env" docs', 'grep -c "git log -p -- .env" README.md', 'git -c core.pager=cat status',
    'watch -n 5 "ls"', 'eval "echo hi"', 'su -c "ls"', 'sudo -n psql -c "select * from t"', 'pwsh -c "Get-Date"']) {
    assert.equal(policy.bashDenial(cmd, o), null, cmd);
  }
  // Nested deeper than zn follows is refused, never let through.
  assert.ok(policy.bashDenial('sh -c "sh -c \\"sh -c \\\\\\"sh -c \\\\\\\\\\\\\\"echo hi\\\\\\\\\\\\\\"\\\\\\"\\""', o));
});

test('many nested shell code strings are decided within the time budget', (t) => {
  const { o } = keyDir(t, 'zn-shellbudget-');
  const unit = "bash -c 'sh -c \"echo $((1+1))\"'; ";
  let cmd = '';
  for (let i = 0; cmd.length < 98000; i++) cmd += unit.replace('1+1', i + '+1');
  const t0 = process.hrtime.bigint();
  const deny = policy.bashDenial(cmd, o);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < budget(3500), 'took ' + ms + ' ms');
  assert.ok(deny === null || /too many|nests/.test(deny), String(deny));
});

test('code run behind more wrappers, shell options and PowerShell forms is read, for a .env with values and for history', (t) => {
  const { dir, o } = keyDir(t, 'zn-launcher-');
  fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  const enc = Buffer.from('cat .env', 'utf16le').toString('base64');
  // A .env with values on disk is read.
  for (const cmd of ['chrt 1 sh -c "cat .env"', 'strace -f sh -c "cat .env"', 'strace -o /x/log -f bash -c "cat .env"', 'iex "Get-Content .env"', 'Invoke-Expression "Get-Content .env"',
    'taskset 0x1 sh -c "cat .env"', 'taskset -c 0 sh -c "cat .env"', 'runuser -u app -- sh -c "cat .env"', 'runuser -l app -c "cat .env"', 'chroot / sh -c "cat .env"',
    'unbuffer sh -c "cat .env"', 'script -qc "cat .env" /dev/null', 'ltrace -f sh -c "cat .env"', 'nsenter -t 1 -m sh -c "cat .env"',
    'bash -O extglob -c "cat .env"', 'bash --rcfile /x/rc -c "cat .env"', 'bash --init-file /x/rc -c "cat .env"', 'bash +O extglob -o pipefail -c "cat .env"',
    'fish -C "cat .env"', 'fish -c "cat .env"', 'pwsh -en ' + enc, 'pwsh -encodedc ' + enc, 'pwsh -EncodedCom ' + enc, 'pwsh /Command "cat .env"', 'pwsh /c "cat .env"',
    'pwsh -com "cat .env"', 'powershell "cat .env"', 'powershell -NoProfile "cat .env"', 'powershell -ExecutionPolicy Bypass "cat .env"', 'pwsh -File x.ps1 "cat .env"',
    'weirdwrap --flag sh -c "cat .env"', 'weirdwrap -x pwsh -c "cat .env"']) {
    assert.ok(policy.bashDenial(cmd, o), cmd);
  }
  // The same for history, with the file absent.
  const { o: o2 } = keyDir(t, 'zn-launcher2-');
  for (const cmd of ['chrt 1 sh -c "git log -p -- .env"', 'taskset -c 0 bash -c "git log -p -- .env"', 'runuser -u app -- git log -p -- .env', 'chroot / git log -p -- .env',
    'unbuffer git log -p -- .env', 'script -qc "git log -p -- .env" /dev/null', 'strace -f git log -p -- .env', 'bash -O extglob -c "git log -p -- .env"',
    'iex "git log -p -- .env"', 'powershell "git log -p -- .env"', 'nsenter -t 1 git log -p -- .env', 'flock x.lock git log -p -- .env', 'chrt -f 1 git log -p -- .env']) {
    assert.ok(policy.bashDenial(cmd, o2), cmd);
  }
  for (const cmd of ['chrt -p 1234', 'strace -c ls', 'taskset -c 0 npm test', 'script -q out.log', 'powershell Get-Date', 'iex (Get-Date)', 'strace -f -o log ls',
    'taskset 0x1 true', 'runuser -u app -- ls', 'chroot / ls', 'bash -O extglob -c "ls"', 'fish -c "ls"', 'pwsh -File x.ps1', 'pwsh -NoProfile -c "Get-Date"', 'unbuffer ls',
    'flock x.lock ls', 'chrt 1 sh -c "echo hi"', 'psql -c "select * from t"']) {
    assert.equal(policy.bashDenial(cmd, o2), null, cmd);
  }
});

test('shell names that run nothing do not hide a real launcher, a string piped into iex is code, and sg is read like su', (t) => {
  const { dir, o } = keyDir(t, 'zn-launcher3-');
  fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  const decoys = (n, name) => Array.from({ length: n }, () => '--setenv A ' + name).join(' ');
  for (const cmd of ['bwrap ' + decoys(30, 'sh') + ' sh -c "cat .env"', 'bwrap ' + decoys(300, 'zsh') + ' bash -c "cat .env"',
    'weird ' + 'powershell '.repeat(40) + ' -c "cat .env"', 'weird ' + 'su '.repeat(40) + ' -c "cat .env"',
    '"Get-Content .env" | iex', 'echo "cat .env" | iex', 'echo "Get-Content .env" | Invoke-Expression', '"git log -p -- .env" | iex',
    'sg grp -c "cat .env"', 'sg grp -c "git log -p -- .env"']) {
    assert.ok(policy.bashDenial(cmd, o), cmd.slice(0, 60));
  }
  for (const cmd of ['iex (Get-Date)', 'iwr https://example.com/x.ps1 | iex', 'Get-Content run.ps1 | Invoke-Expression', 'bwrap ' + decoys(30, 'sh') + ' sh -c "ls"', 'sg grp -c "ls"']) {
    assert.equal(policy.bashDenial(cmd, o), null, cmd.slice(0, 60));
  }
  let big = 'weird ';
  for (let i = 0; big.length < 98000; i++) big += 'su ';
  const t0 = process.hrtime.bigint();
  const deny = policy.bashDenial(big, o);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 3500);
  assert.ok(deny === null || typeof deny === 'string');
});
