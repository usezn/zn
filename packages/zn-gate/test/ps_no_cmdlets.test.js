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

const winacl = require('../lib/vault/winacl');

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const ME = 'S-1-5-21-111-222-333-1001';

/** The PowerShell texts that the vault ACL code sends, captured with a stub runner. */
function winaclScripts() {
  const seen = [];
  const tools = {
    icacls: 'icacls', whoami: 'whoami', powershell: PS,
    run(file, args, env) {
      if (file === PS) seen.push({ script: args[args.length - 1], env });
      return { status: 0, stdout: 'O:' + ME + 'G:S-1-5-21-111-222-333-513D:PAI(A;OICI;FA;;;' + ME + ')', stderr: '' };
    },
  };
  try { winacl.verifyPrivate('C:\\x\\y', { tools, userSid: ME, dir: true }); } catch (_) { /* the stub answer is only a capture */ }
  try { winacl.ensurePipe('\\\\.\\pipe\\zn-test', { tools, userSid: ME }); } catch (_) { /* same */ }
  try { winacl.scriptWriteRisk('C:\\x\\y.cmd', { tools, userSid: ME }); } catch (_) { /* same */ }
  return seen;
}

const scripts = () => {
  const out = { acl: launcher.WIN_ACL_SCRIPT, private: launcher.WIN_PRIVATE_SCRIPT };
  for (const [id, events] of [['antigravity', ['PreToolUse']], ['cursor', ['beforeShellExecution', 'stop']], ['gemini', ['BeforeTool', 'AfterTool']], ['codex', ['PreToolUse', 'PermissionRequest', 'Stop']]]) {
    for (const e of events) out['hook ' + id + ' ' + e] = launcher.windowsScript(id, e, 'C:/node/node.exe', 'C:/z/runner.js');
  }
  for (const id of ['codex', 'cursor']) out['hook with deadline ' + id] = launcher.windowsScript(id, id === 'cursor' ? 'beforeShellExecution' : 'PreToolUse', 'C:/node/node.exe', 'C:/z/runner.js', { deadlineS: 5 });
  out['project hook'] = launcher.projectWindowsScript('antigravity');
  const gui = confirm.guiCommand({ title: 't', message: 'm' }, { platform: 'win32', powershell: PS, exists: () => true });
  out['confirm dialog'] = Buffer.from(gui.args[gui.args.length - 1], 'base64').toString('utf16le');
  winaclScripts().forEach((c, i) => { out['vault acl ' + i] = c.script; });
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
  assert.ok(Object.keys(all).length >= 16, Object.keys(all).join(','));
  assert.equal(winaclScripts().length, 3);
  for (const [name, script] of Object.entries(all)) {
    assert.equal(typeof script, 'string', name);
    assert.deepEqual(commands(script), [], name + ' calls a cmdlet or alias');
  }
});

test('the hook scripts, the ZCode launcher included, find zn and node with .NET (zf), not with Get-Command', () => {
  for (const opts of [{}, { deadlineS: 5 }]) {
    const s = launcher.windowsScript('codex', 'PreToolUse', 'C:/node/node.exe', 'C:/z/runner.js', opts);
    assert.match(s, /function zf\(\$x\)/);
    assert.match(s, /\[System\.IO\.File\]::Exists\('C:\/node\/node\.exe'\)/);
    assert.doesNotMatch(s, /Get-Command|Test-Path|New-Object|Start-Process|Wait-Process|Stop-Process/);
    if (opts.deadlineS) assert.match(s, /\[System\.Diagnostics\.ProcessStartInfo\]::new\(\)/);
  }
  const s = launcher.windowsScript('cursor', 'beforeShellExecution', 'C:/node/node.exe', 'C:/z/runner.js');
  assert.match(s, /& \(zf 'zn\.cmd'\) hook cursor/);
  const cmd = launcher.windowsScriptCommand(s);
  assert.equal(windowsCommandScript(cmd), s);
  const parsed = require('../lib/check')._internal.parseCommand(cmd, 'cursor');
  assert.equal(parsed.node, 'C:/node/node.exe');
  assert.equal(parsed.runner, 'C:/z/runner.js');
});

test('the scripts that zn starts get a PSModulePath with only the system module folder', () => {
  assert.equal(exe.systemPsModulePath(PS), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  const gui = confirm.guiCommand({ title: 't', message: 'm' }, { platform: 'win32', powershell: PS, exists: () => true });
  assert.equal(gui.env.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  const calls = [];
  const spawnSync = (file, args, o) => { calls.push(o); return { status: 0, stdout: 'U\tS-1-5-21-1\nZ\n', stderr: '' }; };
  launcher.readWinAcls(['C:\\a'], { spawnSync, powershell: PS });
  launcher.setWinPrivate('C:\\a', 'S-1-5-21-1', { spawnSync, powershell: PS });
  assert.equal(calls.length, 2);
  for (const o of calls) assert.equal(o.env.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
});

test('the SDDL of the vault ACL check is read with .NET: Access, Owner and Group', () => {
  const [first] = winaclScripts();
  assert.match(first.script, /GetSecurityDescriptorSddlForm\(\[System\.Security\.AccessControl\.AccessControlSections\]14\)/);
  assert.doesNotMatch(first.script, /Get-Acl/);
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
  const existed = fs.existsSync(path.join(os.homedir(), 'Documents', 'WindowsPowerShell'));
  const mark = "[System.IO.File]::AppendAllText('" + marker.replace(/'/g, "''") + "', 'x')";
  const made = [];
  const evil = path.join(os.tmpdir(), 'zn-evil-' + process.pid + '.cmd');
  fs.writeFileSync(evil, '@echo x>>"' + marker + '"\r\n@exit /b 0\r\n');
  for (const [mod, fns] of [['Microsoft.PowerShell.Utility', ['ConvertTo-Json', 'New-Object', 'Write-Output', 'Add-Type', 'Select-Object', 'ForEach-Object', 'Where-Object', 'Start-Process', 'Wait-Process', 'Stop-Process', 'Out-Null', 'Out-String']], ['Microsoft.PowerShell.Management', ['Test-Path', 'Get-Command', 'Join-Path', 'Split-Path', 'Get-Content', 'Stop-Process', 'Wait-Process']], ['Microsoft.PowerShell.Security', ['Get-Acl']]]) {
    const dir = path.join(mods, mod);
    fs.mkdirSync(dir, { recursive: true });
    made.push(dir);
    // Get-Command answers with the planted program (a .cmd that exits 0 and leaves a second marker): where zn used Get-Command to find
    // `zn.cmd`, this would make a hook that cannot start look like an answer of exit 0 (an allow)
    fs.writeFileSync(path.join(dir, mod + '.psm1'), fns.map((f) => 'function ' + f + ' { ' + mark + '; ' + (f === 'Get-Command' ? "[pscustomobject]@{ Source = '" + evil.replace(/'/g, "''") + "' }" : "'{}'") + ' }').concat('Export-ModuleMember -Function *').join('\r\n'));
  }
  t.after(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
    if (!existed) fs.rmSync(path.join(os.homedir(), 'Documents', 'WindowsPowerShell'), { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
    fs.rmSync(evil, { force: true });
  });
  return marker;
}

test('real Windows: a module planted in the user Documents folder does not change the ACL checks, the hook script, the ZCode launcher or the vault ACL read', { skip: !realOn }, (t) => {
  const marker = plantUtilityModule(t);
  const ps = exe.systemPowerShell();
  const root = path.win32.dirname(path.win32.dirname(path.win32.dirname(path.win32.dirname(ps))));
  const bare = { SystemRoot: root, windir: root, PATH: root + '\\System32' };
  // control: the old way (Test-Path with a planted Management module) IS fooled on this machine, so the attack is real here
  const old = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', "[Console]::Out.Write((Test-Path -LiteralPath 'C:\\'))"], { env: bare, encoding: 'utf8' });
  assert.ok(fs.existsSync(marker), 'the planted module should answer for Test-Path: ' + old.stdout + old.stderr);
  fs.rmSync(marker);
  const dir = tempDir(t, 'zn-planted-hook-');
  const quick = path.join(dir, 'quick.js');
  fs.writeFileSync(quick, "process.stdin.resume(); process.stdin.on('end', () => process.exit(2)); process.stdin.on('error', () => process.exit(2));\n");
  const slow = path.join(dir, 'slow.js');
  fs.writeFileSync(slow, 'setTimeout(() => process.exit(0), 60000);\n');
  const run = (script, env, input) => spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { input: input || '{}', encoding: 'utf8', cwd: dir, env, timeout: 40000 });
  // plain hook script: the runner's exit code 2 (a block) comes out, nothing planted ran
  let r = run(launcher.windowsScript('codex', 'PreToolUse', process.execPath, quick), undefined);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(marker), 'a planted cmdlet ran in the hook script');
  // the ZCode-style launcher (zr with a deadline): the same exit code, and a hook that hangs is stopped and blocked (exit 2)
  r = run(launcher.windowsScript('codex', 'PreToolUse', process.execPath, quick, { deadlineS: 5 }), undefined);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const t0 = Date.now();
  r = run(launcher.windowsScript('codex', 'PreToolUse', process.execPath, slow, { deadlineS: 3 }), undefined);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(Date.now() - t0 < 30000, 'the deadline did not stop the hook');
  assert.ok(!fs.existsSync(marker), 'a planted cmdlet ran in the ZCode launcher');
  // no recorded node and no zn on the PATH: the hook still blocks (exit 2)
  r = run(launcher.windowsScript('codex', 'PreToolUse', 'C:/zn-no-such/node.exe', 'C:/zn-no-such/runner.js'), bare);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(marker), 'a planted cmdlet ran in the hook script (no node)');
  // the same with the deadline form (zr): a planted Get-Command must not turn "cannot start" into exit 0
  r = run(launcher.windowsScript('codex', 'PreToolUse', 'C:/zn-no-such/node.exe', 'C:/zn-no-such/runner.js', { deadlineS: 5 }), bare);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(marker), 'a planted program or cmdlet ran in the ZCode launcher (no node)');
  // the vault ACL read: the real SDDL, not '{}' from a planted Get-Acl
  const sddl = winacl.verifyPrivate(dir, { dir: true });
  assert.ok(Array.isArray(sddl));
  assert.ok(!fs.existsSync(marker), 'a planted cmdlet ran in the vault ACL read');
  // the ACL scripts of the hook folder
  const adir = tempDir(t, 'zn-planted-acl-');
  const doc = launcher.readWinAcls([adir]);
  assert.match(doc.user, /^S-1-5-/);
  assert.equal(doc.entries.length, 1);
  assert.equal(doc.entries[0].path, adir);
  assert.ok(doc.entries[0].aces.length > 0);
  const sub = path.join(adir, 'sub');
  fs.mkdirSync(sub);
  launcher.setWinPrivate(sub, doc.user);
  const after = launcher.readWinAcls([sub]);
  assert.deepEqual(after.entries[0].aces.map((a) => a.sid), [doc.user]);
  assert.ok(!fs.existsSync(marker), 'a planted cmdlet ran in the ACL scripts');
});
