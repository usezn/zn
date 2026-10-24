'use strict';
process.env.ZN_STATS = 'off';
// The PowerShell scripts that zn runs (the ACL checks of ZN_HOOK_DIR, the hook scripts of the agents, the confirmation dialog) use
// no cmdlet at all. A cmdlet (Test-Path, Get-Command, ConvertTo-Json, New-Object...) is loaded from a module, and Windows PowerShell
// 5.1 searches the user's own Documents\WindowsPowerShell\Modules first, so a module planted there by the same account would
// answer in place of the real one. Only .NET types, operators and keywords are allowed; the module path of the scripts that zn
// starts itself is fixed to the system folder as well.
const test = require('node:test');
const assert = require('node:assert/strict');
const launcher = require('../lib/agents/launcher');
const confirm = require('../lib/vault/confirm');
const exe = require('../lib/exe');
const { windowsCommandScript } = require('../lib/shell-quote');

const VERBS = 'Add|Clear|Compare|Convert|ConvertFrom|ConvertTo|Copy|Export|Find|Format|Get|Group|Import|Invoke|Join|Measure|Move|New|Out|Read|Remove|Rename|Resolve|Select|Set|Sort|Split|Start|Stop|Tee|Test|Wait|Where|Write|ForEach';
const CMDLET = new RegExp('(?<![\\w$.:\\[-])(?:' + VERBS + ')-[A-Za-z][A-Za-z0-9]*', 'g');
const ALIASES = new Set(['%', '?', 'select', 'where', 'foreach', 'iex', 'iwr', 'irm', 'gc', 'sc', 'ls', 'dir', 'cat', 'echo', 'write', 'sleep', 'ni', 'rm', 'cp', 'mv', 'gci', 'gcm', 'gi', 'gp', 'sp', 'ac', 'saps', 'start', 'kill', 'ps', 'sort', 'measure', 'ft', 'fl', 'oh', 'type', 'cd', 'pwd', 'curl', 'wget', 'icm', 'ogv']);

/** The script without its comments and the text inside single or double quotes (a message is not a command). */
function code(script) {
  let out = '';
  let i = 0;
  while (i < script.length) {
    const c = script[i];
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < script.length) {
        if (script[i] === q && script[i + 1] === q) { i += 2; continue; }
        if (script[i] === q) break;
        i++;
      }
      out += q + q;
      i++;
    } else if (c === '#') {
      while (i < script.length && script[i] !== '\n') i++;
    } else { out += c; i++; }
  }
  return out;
}

/** The cmdlet names and aliases that the script calls (the first word of each statement or pipeline step, and Verb-Noun names). */
function commands(script) {
  const c = code(script);
  const found = c.match(CMDLET) || [];
  // an alias is the first word of a statement: after ; | { ( = or a newline (the call operator & is followed by a path, a variable or ( )
  const re = /(?:^|[;|{(=\n])\s*([A-Za-z%?][A-Za-z0-9]*|[%?])(?=\s|$|[;|)}])/g;
  let m;
  while ((m = re.exec(c))) {
    const w = m[1].toLowerCase();
    if (w === 'foreach' && /^\s*\(/.test(c.slice(re.lastIndex))) continue; // the keyword, not the ForEach-Object alias
    if (ALIASES.has(w)) found.push(m[1]);
  }
  return found;
}

const scripts = () => {
  const out = { acl: launcher.WIN_ACL_SCRIPT, private: launcher.WIN_PRIVATE_SCRIPT };
  for (const [id, events] of [['antigravity', ['PreToolUse']], ['cursor', ['beforeShellExecution', 'stop']], ['gemini', ['BeforeTool', 'AfterTool']], ['codex', ['PreToolUse', 'PermissionRequest', 'Stop']]]) {
    for (const e of events) out['hook ' + id + ' ' + e] = launcher.windowsScript(id, e, 'C:/node/node.exe', 'C:/z/runner.js');
  }
  out['project hook'] = launcher.projectWindowsScript('antigravity');
  const gui = confirm.guiCommand({ title: 't', message: 'm' }, { platform: 'win32', powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', exists: () => true });
  out['confirm dialog'] = Buffer.from(gui.args[gui.args.length - 1], 'base64').toString('utf16le');
  return out;
};

test('the lint itself finds cmdlets, aliases and Verb-Noun names, and ignores text in quotes', () => {
  assert.deepEqual(commands("$x = Get-Command node; Write-Output 'Get-Acl in a message'"), ['Get-Command', 'Write-Output']);
  assert.deepEqual(commands('$x | ConvertTo-Json -Compress'), ['ConvertTo-Json']);
  assert.deepEqual(commands('$a | select Name; $b = gc x'), ['select', 'gc']);
  assert.deepEqual(commands("$x = New-Object System.Object; if (Test-Path -LiteralPath 'x') { exit 0 }"), ['New-Object', 'Test-Path']);
  assert.deepEqual(commands("[Console]::Out.Write('ok'); $y = [System.IO.File]::Exists('C:/a'); # Get-Command in a comment"), []);
  assert.deepEqual(commands('$p.WaitForExit(5); $i.UseShellExecute = $false; $s -split [char]124'), []);
});

test('every PowerShell script zn runs is free of cmdlets and aliases', () => {
  const all = scripts();
  assert.ok(Object.keys(all).length >= 12);
  for (const [name, script] of Object.entries(all)) {
    assert.equal(typeof script, 'string', name);
    assert.deepEqual(commands(script), [], name + ' calls a cmdlet or alias');
  }
});

test('the hook scripts find zn and node with .NET (zf), not with Get-Command', () => {
  const s = launcher.windowsScript('cursor', 'beforeShellExecution', 'C:/node/node.exe', 'C:/z/runner.js');
  assert.match(s, /function zf\(\$x\)/);
  assert.match(s, /\[System\.IO\.File\]::Exists\('C:\/node\/node\.exe'\)/);
  assert.match(s, /& \(zf 'zn\.cmd'\) hook cursor/);
  assert.doesNotMatch(s, /Get-Command|Test-Path/);
  // the command that is written into the agent's file is still read back by `zn-gate check`
  const cmd = launcher.windowsScriptCommand(s);
  assert.equal(windowsCommandScript(cmd), s);
  const parsed = require('../lib/check')._internal.parseCommand(cmd, 'cursor');
  assert.equal(parsed.node, 'C:/node/node.exe');
  assert.equal(parsed.runner, 'C:/z/runner.js');
});

test('the scripts that zn starts get a PSModulePath with only the system module folder', () => {
  const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  assert.equal(exe.systemPsModulePath(ps), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  const gui = confirm.guiCommand({ title: 't', message: 'm' }, { platform: 'win32', powershell: ps, exists: () => true });
  assert.equal(gui.env.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  const calls = [];
  const spawnSync = (file, args, o) => { calls.push(o); return { status: 0, stdout: 'U\tS-1-5-21-1\nZ\n', stderr: '' }; };
  launcher.readWinAcls(['C:\\a'], { spawnSync, powershell: ps });
  launcher.setWinPrivate('C:\\a', 'S-1-5-21-1', { spawnSync, powershell: ps });
  assert.equal(calls.length, 2);
  for (const o of calls) assert.equal(o.env.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
});

test('the line format of the ACL script is read strictly', () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const ME = 'S-1-5-21-1-2-3-1001';
  const ok = ['U\t' + ME, 'E\t' + b64('C:\\ü ünï\\a') + '\t' + ME + '\t1\t0', 'A\t' + ME + '\t2032127\tAllow\t0\t3', 'A\tS-1-1-0\t278\tDeny\t1\t1', 'E\t' + b64('C:\\f') + '\tS-1-5-18\t0\t1', 'Z', ''].join('\r\n');
  const doc = launcher.parseWinAcls(ok);
  assert.equal(doc.user, ME);
  assert.equal(doc.entries.length, 2);
  assert.equal(doc.entries[0].path, 'C:\\ü ünï\\a');
  assert.equal(doc.entries[0].dir, true);
  assert.deepEqual(doc.entries[0].aces[1], { sid: 'S-1-1-0', rights: 278, type: 'Deny', inheritOnly: true, inh: 1 });
  assert.equal(doc.entries[1].reparse, true);
  for (const bad of ['', 'Z\n', 'U\t' + ME + '\n', 'U\t' + ME + '\nZ\nE\tx\n', 'U\tnot-a-sid\nZ\n', 'A\t' + ME + '\t1\tAllow\t0\t0\nZ\n', 'U\t' + ME + '\nU\t' + ME + '\nZ\n', 'U\t' + ME + '\nQ\nZ\n', '{"user":"' + ME + '","entries":[]}']) {
    assert.throws(() => launcher.parseWinAcls(bad), /unreadable answer/, JSON.stringify(bad));
  }
});

// ---- real Windows: a module planted in the user's own Documents folder (opt-in, run on a VM as SYSTEM, admin and a standard user)
const realOn = process.platform === 'win32' && process.env.ZN_WIN_REAL_CHAIN;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

/** Plants Microsoft.PowerShell.Utility in <home>\Documents\WindowsPowerShell\Modules: its cmdlets leave a marker and give a "safe" answer. */
function plantUtilityModule(t) {
  const marker = path.join(os.tmpdir(), 'zn-planted-' + process.pid + '-' + Date.now() + '.txt');
  const mods = path.join(os.homedir(), 'Documents', 'WindowsPowerShell', 'Modules');
  const dir = path.join(mods, 'Microsoft.PowerShell.Utility');
  const existed = fs.existsSync(path.join(os.homedir(), 'Documents', 'WindowsPowerShell'));
  fs.mkdirSync(dir, { recursive: true });
  const mark = "[System.IO.File]::AppendAllText('" + marker.replace(/'/g, "''") + "', 'x')";
  fs.writeFileSync(path.join(dir, 'Microsoft.PowerShell.Utility.psm1'), [
    'function ConvertTo-Json { ' + mark + '; \'{"user":"S-1-0-0","entries":[]}\' }',
    'function New-Object { ' + mark + '; throw "planted" }',
    'function Write-Output { ' + mark + ' }',
    'function Add-Type { ' + mark + ' }',
    'function Select-Object { ' + mark + ' }',
    'function ForEach-Object { ' + mark + ' }',
    'function Where-Object { ' + mark + ' }',
    'Export-ModuleMember -Function *',
  ].join('\r\n'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (!existed) fs.rmSync(path.join(os.homedir(), 'Documents', 'WindowsPowerShell'), { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
  });
  return marker;
}

test('real Windows: a module planted in the user Documents folder does not change the ACL checks or the hook script', { skip: !realOn }, (t) => {
  const marker = plantUtilityModule(t);
  const ps = exe.systemPowerShell();
  const root = path.win32.dirname(path.win32.dirname(path.win32.dirname(path.win32.dirname(ps))));
  const bare = { SystemRoot: root, windir: root, PATH: root + '\\System32' };
  // control: the old way (ConvertTo-Json, no PSModulePath) IS fooled on this machine, so the attack is real here
  const old = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', '[pscustomobject]@{ a = 1 } | ConvertTo-Json -Compress'], { env: bare, encoding: 'utf8' });
  assert.match(old.stdout, /S-1-0-0/, 'the planted module should answer for ConvertTo-Json: ' + old.stdout + old.stderr);
  assert.ok(fs.existsSync(marker));
  fs.rmSync(marker);
  // the ACL scripts
  const dir = tempDir(t, 'zn-planted-acl-');
  const doc = launcher.readWinAcls([dir]);
  assert.match(doc.user, /^S-1-5-/);
  assert.equal(doc.entries.length, 1);
  assert.equal(doc.entries[0].path, dir);
  assert.ok(doc.entries[0].aces.length > 0);
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  launcher.setWinPrivate(sub, doc.user);
  const after = launcher.readWinAcls([sub]);
  assert.deepEqual(after.entries[0].aces.map((a) => a.sid), [doc.user]);
  assert.ok(!fs.existsSync(marker), 'a planted cmdlet ran in the ACL scripts');
  // the hook script: the runner's exit code 2 (a block) still comes out
  const runner = path.join(dir, 'runner.js');
  fs.writeFileSync(runner, "process.stdin.resume(); process.stdin.on('end', () => process.exit(2)); process.stdin.on('error', () => process.exit(2));\n");
  const script = launcher.windowsScript('codex', 'PreToolUse', process.execPath, runner);
  const hook = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { input: '{}', encoding: 'utf8', cwd: dir });
  assert.equal(hook.status, 2, hook.stdout + hook.stderr);
  assert.ok(!fs.existsSync(marker), 'a planted cmdlet ran in the hook script');
  // no recorded node and no zn on the PATH: the hook still blocks (exit 2)
  const gone = launcher.windowsScript('codex', 'PreToolUse', 'C:/zn-no-such/node.exe', 'C:/zn-no-such/runner.js');
  const blocked = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(gone, 'utf16le').toString('base64')], { input: '{}', encoding: 'utf8', cwd: dir, env: bare });
  assert.equal(blocked.status, 2, blocked.stdout + blocked.stderr);
  assert.ok(!fs.existsSync(marker), 'a planted cmdlet ran in the hook script (no node)');
});
