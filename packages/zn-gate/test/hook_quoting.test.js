'use strict';

// Paths in the commands zn writes for a shell (hook commands, the `zn run`
// prefix of rewritten Bash commands, the Monitor wrapper, the PowerShell
// wrapper) reach the program literally, whatever characters they hold.
// Each command is run for real with a fake node that records its argv.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const sq = require('../lib/shell-quote');
const cfg = require('../lib/agents/config-file');
const claude = require('../lib/agents/claude-code');
const runner = require('../lib/hooks/runner');
const policy = require('../lib/hooks/policy');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');
const { runScript } = require('./helpers/shell');

const POSIX = process.platform !== 'win32';
const CANARY = 'zn-canary';

// Directory names a user's install path could contain.
const NAMES = [
  'with space',
  "it's",
  'say "hi"',
  '$(touch ' + CANARY + ')',
  '`touch ' + CANARY + '`',
  '$HOME',
  "x'; touch " + CANARY + "; echo '",
  'back\\slash',
  'trailing\\',
  '/opt/a\\\'b"; touch canary; #',
  '/opt/back\\\\slash',
  'new\nline',
  'é 中文 😀',
  '%PATH% !x! ^&|<>',
];

function canRun(bin) {
  const r = spawnSync(bin, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}
const PWSH = canRun('pwsh');

/** A directory whose path ends in `name`, holding a fake node and runner. */
function fakeInstall(t, name) {
  const root = tempDir(t, 'zn-quote-');
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const node = path.join(dir, 'node');
  // Writes each argument NUL-terminated, then ZN_AGENT, to $ZN_ARGV_OUT, and
  // reads its input like the real scrubber does (so a pipe into it ends cleanly).
  fs.writeFileSync(node, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\0\' "$a"; done > "$ZN_ARGV_OUT"\nprintf \'agent=%s\\0\' "$ZN_AGENT" >> "$ZN_ARGV_OUT"\ncat > /dev/null\n', { mode: 0o755 });
  const runnerJs = path.join(dir, 'runner.js');
  fs.writeFileSync(runnerJs, '');
  return { root, dir, node, runnerJs, out: path.join(root, 'argv.out') };
}

function readArgv(out) {
  const parts = fs.readFileSync(out, 'utf8').split('\0');
  parts.pop();
  const agent = parts.pop();
  return { argv: parts, agent: agent.replace(/^agent=/, '') };
}

/** Run a command line in a shell (read from a script file, see helpers/shell.js). */
function runIn(t, shell, cmd, f, flags = []) {
  const r = runScript(t, shell, cmd, { cwd: f.root, env: { ...process.env, ZN_ARGV_OUT: f.out, HOME: f.root } }, flags);
  assert.equal(r.status, 0, shell + ': ' + r.stderr);
  assert.ok(!fs.existsSync(path.join(f.root, CANARY)), 'nothing else ran in ' + shell + ' for ' + JSON.stringify(cmd));
  return readArgv(f.out);
}

/* ------------------------------ unit ------------------------------ */

test('shQuote and powershellQuote: exact strings', () => {
  assert.equal(sq.shQuote('/a b/c'), "'/a b/c'");
  // A quote is written as '"'"' (not '\''): PowerShell keeps it inside a string too.
  assert.equal(sq.shQuote("it's"), "'it'\"'\"'s'");
  assert.equal(sq.shQuote('a’b'), "'a'\"’\"'b'");
  // A backslash is written as '"\\"' (fish reads \\ and \' inside single quotes).
  assert.equal(sq.shQuote('$(x) `y` $HOME \\ "'), "'$(x) `y` $HOME '\"\\\\\"' \"'");
  assert.equal(sq.shQuote(''), "''");
  assert.equal(sq.powershellQuote("it's"), "'it''s'");
  // PowerShell also ends a single-quoted string at a typographic single quote.
  assert.equal(sq.powershellQuote('a\u2018b\u2019c\u201Ad\u201Be'), "'a\u2018\u2018b\u2019\u2019c\u201A\u201Ad\u201B\u201Be'");
  assert.equal(sq.powershellQuote('$env:X $(1) `n "'), "'$env:X $(1) `n \"'");
  assert.throws(() => sq.shQuote('a\0b'), /NUL/);
  assert.throws(() => sq.powershellQuote('a\0b'), /NUL/);
});

test('portablePath: \\ becomes / on Windows only', () => {
  assert.equal(sq.portablePath('C:\\Program Files\\nodejs\\node.exe', 'win32'), 'C:/Program Files/nodejs/node.exe');
  assert.equal(sq.portablePath('/opt/a\\b', 'linux'), '/opt/a\\b');
});

test('hook commands: single quotes for sh, older double-quoted commands still recognised', () => {
  assert.equal(cfg.hookCommand('codex', { scope: 'user', nodePath: '/n/node', runnerPath: '/r/runner.js', platform: 'linux' }), "'/n/node' '/r/runner.js' codex");
  assert.equal(claude.hookCommand({ nodePath: '/n/$(x)/node', runnerPath: '/r/runner.js', platform: 'linux' }), "'/n/$(x)/node' '/r/runner.js' claude-code");
  assert.equal(cfg.hookCommand('codex', { scope: 'user', nodePath: 'C:\\n\\node.exe', runnerPath: 'C:\\r\\runner.js', platform: 'win32' }), "'C:/n/node.exe' 'C:/r/runner.js' codex");
  for (const id of ['codex', 'cursor']) {
    assert.ok(cfg.isOurs("'/n/node' '/r/lib/hooks/runner.js' " + id, id));
    assert.ok(cfg.isOurs('"/n/node" "/r/lib/hooks/runner.js" ' + id, id), 'double-quoted command of an older version');
    assert.ok(cfg.isOurs('zn hook ' + id, id));
    assert.ok(cfg.isOurs(cfg.hookCommandWindows(id, { nodePath: 'C:\\n\\node.exe', runnerPath: 'C:\\z\\lib\\hooks\\runner.js' }), id));
    assert.ok(cfg.isOurs(cfg.hookCommandWindows(id, { nodePath: 'C:\\100%\\node.exe', runnerPath: 'C:\\z\\lib\\hooks\\runner.js' }), id));
    assert.ok(!cfg.isOurs("'/n/node' '/r/lib/hooks/runner.js' other", id));
    assert.ok(!cfg.isOurs('powershell.exe -NoProfile -NonInteractive -Command "& \'x\' other"', id));
  }
});

test('Windows hook command: readable when plain, encoded when cmd.exe, PowerShell or bash would act on a character', () => {
  const plain = cfg.hookCommandWindows('codex', { nodePath: 'C:\\Program Files\\nodejs\\node.exe', runnerPath: "C:\\it's é\\runner.js" });
  assert.equal(plain, 'powershell.exe -NoProfile -NonInteractive -Command "& \'C:/Program Files/nodejs/node.exe\' \'C:/it\'\'s é/runner.js\' codex"');
  for (const bad of ['%USERPROFILE%', '!x!', '$(calc)', '`calc`', '\u201Cq\u201D', 'a\nb']) {
    const cmd = cfg.hookCommandWindows('codex', { nodePath: 'C:\\' + bad + '\\node.exe', runnerPath: 'C:\\r\\runner.js' });
    assert.match(cmd, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/, bad);
    assert.equal(sq.windowsCommandScript(cmd), "& 'C:/" + bad + "/node.exe' 'C:/r/runner.js' codex");
  }
});

test('install replaces, and uninstall removes, hooks written with double quotes by older versions', (t) => {
  const codex = require('../lib/agents/codex');
  const cursor = require('../lib/agents/cursor');
  const home = tempDir(t, 'zn-quote-old-');
  const old = (id) => '"/usr/bin/node" "/old/lib/hooks/runner.js" ' + id;
  const opts = { home, env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') }, mcp: false, nodePath: '/usr/bin/node', runnerPath: '/new/lib/hooks/runner.js' };

  const ccFile = claude.settingsFile(opts);
  fs.mkdirSync(path.dirname(ccFile), { recursive: true });
  fs.writeFileSync(ccFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: old('claude-code') }] }] } }));
  claude.install(opts);
  const cc = JSON.parse(fs.readFileSync(ccFile, 'utf8'));
  assert.equal(cc.hooks.PreToolUse.length, 1, 'the old hook was replaced');
  assert.match(cc.hooks.PreToolUse[0].hooks[0].command, /^'.*' claude-code$/);
  fs.writeFileSync(ccFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: old('claude-code') }] }] } }));
  claude.uninstall(opts);
  assert.deepEqual(JSON.parse(fs.readFileSync(ccFile, 'utf8')), {});

  const cxFile = codex.hooksFile(opts);
  fs.mkdirSync(path.dirname(cxFile), { recursive: true });
  fs.writeFileSync(cxFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: old('codex') }] }] } }));
  codex.install(opts);
  assert.equal(JSON.parse(fs.readFileSync(cxFile, 'utf8')).hooks.PreToolUse.length, 1);
  codex.uninstall(opts);
  assert.deepEqual(JSON.parse(fs.readFileSync(cxFile, 'utf8')).hooks || {}, {});

  const cuFile = cursor.hooksFile(opts);
  fs.mkdirSync(path.dirname(cuFile), { recursive: true });
  fs.writeFileSync(cuFile, JSON.stringify({ version: 1, hooks: { beforeReadFile: [{ command: old('cursor') }] } }));
  cursor.install(opts);
  assert.equal(JSON.parse(fs.readFileSync(cuFile, 'utf8')).hooks.beforeReadFile.length, 1);
  cursor.uninstall(opts);
  assert.deepEqual(JSON.parse(fs.readFileSync(cuFile, 'utf8')).hooks, {});

  // On Windows Cursor gets the powershell.exe form, and it is recognised as ours.
  cursor.install({ ...opts, platform: 'win32' });
  const win = JSON.parse(fs.readFileSync(cuFile, 'utf8')).hooks.beforeReadFile;
  assert.equal(win.length, 1);
  assert.match(win[0].command, /^powershell\.exe -NoProfile -NonInteractive -Command "& '\/usr\/bin\/node' '\/new\/lib\/hooks\/runner\.js' cursor"$/);
  cursor.uninstall(opts);
  assert.deepEqual(JSON.parse(fs.readFileSync(cuFile, 'utf8')).hooks, {});
});

/* ------------------------ executed in a shell ------------------------ */

test('hook commands run in sh and bash with every argument literal', { skip: !POSIX && 'needs sh' }, (t) => {
  for (const name of NAMES) {
    const f = fakeInstall(t, name);
    const commands = [
      [claude.hookCommand({ nodePath: f.node, runnerPath: f.runnerJs }), 'claude-code'],
      [cfg.hookCommand('codex', { nodePath: f.node, runnerPath: f.runnerJs }), 'codex'],
      [cfg.hookCommand('cursor', { nodePath: f.node, runnerPath: f.runnerJs }), 'cursor'],
    ];
    for (const [cmd, id] of commands) {
      // Codex runs hook commands with `$SHELL -lc`, Claude Code with `sh -c` (Git Bash on Windows).
      for (const [shell, flags] of [['sh', []], ['bash', []], ['bash', ['-l']]]) {
        const { argv } = runIn(t, shell, cmd, f, flags);
        assert.deepEqual(argv, [f.runnerJs, id], shell + ' ' + JSON.stringify(name));
      }
    }
  }
});

test('a rewritten Bash command (zn run prefix) runs with literal paths', { skip: !POSIX && 'needs bash' }, async (t) => {
  for (const name of NAMES) {
    const f = fakeInstall(t, name);
    const runJs = path.join(f.dir, 'run.js');
    const raw = {
      session_id: 's', cwd: f.root, permission_mode: 'default', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command: 'psql __ZN_DB_PASSWORD__ -c "select 1"' }, tool_use_id: 't',
    };
    const res = await runner.handle(claude, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'closed', nodePath: f.node, runJs });
    const cmd = res.output.hookSpecificOutput.updatedInput.command;
    const { argv, agent } = runIn(t, 'bash', cmd, f);
    assert.deepEqual(argv, [runJs, '--', 'psql', '__ZN_DB_PASSWORD__', '-c', 'select 1'], JSON.stringify(name));
    assert.equal(agent, 'claude-code');
  }
});

test('the Monitor wrapper pipes into the scrubber with literal paths', { skip: !POSIX && 'needs bash' }, async (t) => {
  for (const name of NAMES) {
    const f = fakeInstall(t, name);
    const raw = {
      session_id: 's', cwd: f.root, permission_mode: 'default', hook_event_name: 'PreToolUse',
      tool_name: 'Monitor', tool_input: { command: 'echo hi' }, tool_use_id: 't',
    };
    const res = await runner.handle(claude, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'closed', nodePath: f.node });
    const cmd = res.output.hookSpecificOutput.updatedInput.command;
    const { argv } = runIn(t, 'bash', cmd, f);
    assert.deepEqual(argv, [path.resolve(__dirname, '..', 'lib', 'scrub', 'stream.js')], JSON.stringify(name));
  }
});

test('the Windows hook command reaches powershell.exe intact through sh and bash', { skip: !POSIX && 'needs sh' }, (t) => {
  // A fake powershell.exe on PATH records the arguments it gets.
  const names = NAMES.filter((n) => !n.includes('\\'));
  for (const name of names) {
    const f = fakeInstall(t, name);
    const bin = path.join(f.root, 'bin');
    fs.mkdirSync(bin);
    fs.copyFileSync(f.node, path.join(bin, 'powershell.exe'));
    fs.chmodSync(path.join(bin, 'powershell.exe'), 0o755);
    const cmd = cfg.hookCommandWindows('codex', { nodePath: f.node, runnerPath: f.runnerJs });
    for (const shell of ['sh', 'bash']) {
      const r = runScript(t, shell, cmd, { cwd: f.root, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ZN_ARGV_OUT: f.out } });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!fs.existsSync(path.join(f.root, CANARY)));
      const { argv } = readArgv(f.out);
      assert.deepEqual(argv.slice(0, 2), ['-NoProfile', '-NonInteractive']);
      const script = argv[2] === '-Command' ? argv[3] : Buffer.from(argv[3], 'base64').toString('utf16le');
      assert.equal(script, sq.windowsCommandScript(cmd), JSON.stringify(name));
      assert.equal(script, '& ' + sq.powershellQuote(f.node) + ' ' + sq.powershellQuote(f.runnerJs) + ' codex');
    }
  }
});

test('PowerShell: quoted paths and the PowerShell wrapper run literally in pwsh', { skip: (!PWSH || !POSIX) && 'pwsh not installed' }, (t) => {
  const names = [...NAMES, 'typo\u2019graphic\u2018', 'dq\u201Cx\u201D'];
  for (const name of names) {
    const f = fakeInstall(t, name);
    // The script of the Windows hook command, plain and encoded.
    const cmd = cfg.hookCommandWindows('cursor', { nodePath: f.node, runnerPath: f.runnerJs });
    const script = sq.windowsCommandScript(cmd);
    if (!name.includes('\\')) {
      assert.deepEqual(runIn(t, 'pwsh', script, f).argv, [f.runnerJs, 'cursor'], JSON.stringify(name));
      const enc = Buffer.from(script, 'utf16le').toString('base64');
      const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { cwd: f.root, encoding: 'utf8', env: { ...process.env, ZN_ARGV_OUT: f.out } });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!fs.existsSync(path.join(f.root, CANARY)));
      assert.deepEqual(readArgv(f.out).argv, [f.runnerJs, 'cursor']);
    }
    // The PowerShell tool rewrite (zn run in front of a native command).
    const runJs = path.join(f.dir, 'run.js');
    const w = policy.wrapPowerShell("psql '__ZN_DB_PASSWORD__' -c 'select 1'", { nodePath: f.node, runJs, agent: 'claude-code' });
    assert.ok(w.ok && w.wrapped, w.reason);
    assert.deepEqual(runIn(t, 'pwsh', w.command, f).argv,
      [runJs, '--agent', 'claude-code', '--', 'psql', '__ZN_DB_PASSWORD__', '-c', 'select 1'], JSON.stringify(name));
  }
});

test('PowerShell reading an sh-quoted command runs nothing from the paths', { skip: (!PWSH || !POSIX) && 'pwsh not installed' }, async (t) => {
  // Claude Code falls back to PowerShell for hook commands when Git Bash is
  // missing, and OpenCode's bash tool runs PowerShell on Windows unless SHELL
  // names another shell. The sh form is not a valid PowerShell call, but no
  // part of a path may run.
  // (pwsh on Linux and macOS also runs the touch of the sh names.)
  const names = [...NAMES, '$(New-Item ' + CANARY + ')', "a'b $(New-Item " + CANARY + ")'c", "x'; New-Item " + CANARY + "; '",
    'typo’ $(New-Item ' + CANARY + ') ‘x', '@(New-Item ' + CANARY + ')'];
  for (const name of names) {
    const f = fakeInstall(t, name);
    const raw = {
      session_id: 's', cwd: f.root, permission_mode: 'default', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command: 'psql __ZN_DB_PASSWORD__' }, tool_use_id: 't',
    };
    const res = await runner.handle(claude, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'closed', nodePath: f.node, runJs: path.join(f.dir, 'run.js') });
    const commands = [claude.hookCommand({ nodePath: f.node, runnerPath: f.runnerJs }), res.output.hookSpecificOutput.updatedInput.command];
    for (const cmd of commands) {
      runScript(t, 'pwsh', cmd, { cwd: f.root, env: { ...process.env, ZN_ARGV_OUT: f.out } });
      assert.ok(!fs.existsSync(path.join(f.root, CANARY)), 'nothing ran in pwsh for ' + JSON.stringify(cmd));
    }
  }
});
