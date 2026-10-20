'use strict';

// zn hooks install claude-code on Windows. Claude Code runs a hook command with Git Bash, or with PowerShell when
// Git Bash is not installed, and cmd.exe can end up running it too, so the command must read the same in all
// three: a powershell.exe call with nothing for a shell to expand. Everything runs in a temporary home and with
// a simulated platform: nothing is written to the real ~/.zn or ~/.claude.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { getAdapter } = require('../lib/agents');
const cfg = require('../lib/agents/config-file');
const launcher = require('../lib/agents/launcher');
const runtime = require('../lib/agents/runtime');
const { check } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const claude = getAdapter('claude-code');
const RUNNER = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');
const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'UserPromptExpansion'];
const BS = String.fromCharCode(92);
const winPath = (...parts) => parts.join(BS);
const ENCODED = /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/;

function setup(t, extra = {}) {
  const home = tempDir(t, 'zn-b135-');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
  const opts = { env, home, nodePath: process.execPath, runnerPath: RUNNER, mcp: false, platform: 'win32', ...extra };
  claude.install(opts);
  const data = JSON.parse(fs.readFileSync(claude.settingsFile({ env, home }), 'utf8'));
  return { home, env, opts, data };
}

const scriptOf = (cmd) => Buffer.from(cmd.split(' ').pop(), 'base64').toString('utf16le');

test('claude-code on Windows: the user hook command is one encoded powershell.exe call that no shell expands', (t) => {
  const { data, home } = setup(t);
  for (const ev of EVENTS) {
    const h = data.hooks[ev][0].hooks[0];
    assert.match(h.command, ENCODED, ev + ' has no quote, $, % or ! for Git Bash, PowerShell or cmd.exe to act on');
    assert.ok(cfg.isOurs(h.command, 'claude-code'), ev + ' is recognized as zn\'s');
  }
  assert.equal(fs.existsSync(launcher.launcherFile('claude-code', { env: { ZN_HOME: path.join(home, '.zn') }, home })), false, 'no sh launcher on Windows');
});

test('claude-code on Windows: it keeps the launcher semantics (Node.js gone: block with exit 2, warn after the tool ran)', (t) => {
  const { data } = setup(t);
  for (const ev of ['PreToolUse', 'UserPromptSubmit', 'UserPromptExpansion']) {
    const s = scriptOf(data.hooks[ev][0].hooks[0].command);
    assert.match(s, /^if \(\(Test-Path -LiteralPath '[^']+'\) -and \(Test-Path -LiteralPath '[^']+runner\.js'\)\) \{ & '[^']+' '[^']+runner\.js' claude-code; exit \$LASTEXITCODE \}/, ev);
    assert.match(s, /Get-Command zn .*& zn hook claude-code/, ev + ' falls back to zn on the PATH');
    assert.match(s, /\[Console\]::Error\.WriteLine\('zn: its hook cannot start[^;]*; exit 2 # zn hook claude-code$/, ev + ' blocks');
  }
  const post = scriptOf(data.hooks.PostToolUse[0].hooks[0].command);
  assert.doesNotMatch(post, /exit 2/);
  assert.match(post, /systemMessage/);
});

test('claude-code on Windows: PreToolUse carries the same onFailure as before (this change does not touch it)', (t) => {
  const { data } = setup(t);
  assert.equal(data.hooks.PreToolUse[0].hooks[0].onFailure, 'block');
  assert.equal(data.hooks.PostToolUse[0].hooks[0].onFailure, undefined);
});

test('claude-code on Windows: install is idempotent, replaces the old single-quoted form, and uninstall removes it', (t) => {
  const { home, env, opts } = setup(t);
  const file = claude.settingsFile({ env, home });
  const old = "'C:/Program Files/nodejs/node.exe' 'C:/x/zn-gate/lib/hooks/runner.js' claude-code";
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.hooks.PreToolUse.unshift({ matcher: 'Bash', hooks: [{ type: 'command', command: old }] });
  fs.writeFileSync(file, JSON.stringify(data));
  claude.install(opts);
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(again.hooks.PreToolUse.length, 1, 'one group: the old form was replaced, not kept next to the new one');
  assert.match(again.hooks.PreToolUse[0].hooks[0].command, ENCODED);
  assert.equal(claude.uninstall(opts).removed, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks, undefined);
});

test('claude-code on Windows: a project install is a plain powershell.exe call of the runner', (t) => {
  const home = tempDir(t, 'zn-b135-proj-');
  const proj = path.join(home, 'proj');
  const opts = {
    scope: 'project', projectDir: proj, home, env: { HOME: home }, mcp: false, platform: 'win32',
    nodePath: winPath('C:', 'Program Files', 'nodejs', 'node.exe'),
    runnerPath: winPath('C:', 'zn', 'lib', 'hooks', 'runner.js'),
  };
  claude.install(opts);
  const file = path.join(proj, '.claude', 'settings.json');
  const cmd = JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse[0].hooks[0].command;
  assert.equal(cmd, 'powershell.exe -NoProfile -NonInteractive -Command "& \'C:/Program Files/nodejs/node.exe\' \'C:/zn/lib/hooks/runner.js\' claude-code"');
  assert.ok(cfg.isOurs(cmd, 'claude-code'));
  assert.equal(claude.uninstall(opts).removed, 1);
});

test('claude-code on Windows: a path with a quote falls back to the plain powershell.exe call, not a broken script', (t) => {
  const { data } = setup(t, { nodePath: "C:/it's/node.exe" });
  const cmd = data.hooks.PreToolUse[0].hooks[0].command;
  assert.match(cmd, /^powershell\.exe -NoProfile -NonInteractive -Command "& 'C:\/it''s\/node\.exe' '[^']+runner\.js' claude-code"$/);
});

test('npx cache paths with backslashes (Windows) count as a temporary copy', () => {
  const cache = winPath('C:', 'Users', 'Ana Garcia', 'AppData', 'Local', 'npm-cache', '_npx', 'abc123', 'node_modules', 'zn-gate', 'lib', 'hooks', 'runner.js');
  assert.equal(runtime.inTemporaryCopy(cache), true);
  assert.equal(runtime.inTemporaryCopy(winPath('C:', 'Users', 'Ana', '.zn', 'runtime', '1.0.0', 'zn-gate', 'lib', 'hooks', 'runner.js')), false);
});

test('check: the Windows hook command is read as installed and protected', async (t) => {
  const { home, env } = setup(t);
  const r = (await check({ home, env, cwd: tempDir(t, 'zn-b135-cwd-'), nodeVersion: '22.0.0' })).results.find((x) => x.id === 'claude-code');
  assert.notEqual(r.state, 'not-installed', JSON.stringify(r));
  assert.ok(!r.problem, r.problem);
});
