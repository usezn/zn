'use strict';
process.env.ZN_STATS = 'off';
// The PowerShell tool reads a backslash as a path separator (type .\.env, cp .\.env x), so a protected file named
// that way is refused for every reader and copier, not only for the PowerShell-only cmdlets. Values are fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const adapter = require('../lib/agents/claude-code');
const runner = require('../lib/hooks/runner');
const policy = require('../lib/hooks/policy');
const fakeEngine = require('./helpers/fake_engine');
const { createFakeVault } = require('./helpers/fake_vault');
const { tempDir } = require('./helpers/tmp');

function project(t) {
  const base = path.join(os.homedir(), 'tmpwork');
  fs.mkdirSync(base, { recursive: true });
  const dir = tempDir(t, 'zn-psbs-', base);
  fs.writeFileSync(path.join(dir, '.env'), 'API_TOKEN=fake-not-a-real-secret-value-0000\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# readme\n');
  return dir;
}

const DENY = [
  'gc .\\.env', 'GC .\\.env', 'Gc .\\.env', 'Get-Content .\\.env', 'get-content .\\.env', 'type .\\.env', 'TYPE .\\.env',
  'cat .\\.env', 'more .\\.env', 'Select-String -Path .\\.env -Pattern x', 'sls x .\\.env', 'Import-Csv .\\.env', 'ipcsv .\\.env',
  'gi .\\.env', 'Get-Item .\\.env', 'Copy-Item .\\.env x', 'cpi .\\.env x', 'CPI .\\.env x', 'cp .\\.env x', 'copy .\\.env x',
  'Copy-Item .\\.env x -Force', 'cpi -Path .\\.env -Destination x', 'cpi .\\.env CON',
  "[IO.File]::ReadAllText('.\\.env')", "[System.IO.File]::ReadAllText('.\\.env')", "[System.IO.File]::ReadAllLines('.\\.env')",
  'gc ./.env', 'gc .env', 'type .env', 'cat .env', 'more .env', 'cp .env x', 'copy .env x', 'cpi .env x',
  'gc (Resolve-Path .\\.env)', '$x = gc .\\.env', 'echo (gc .\\.env)',
];
const ALLOW = ['gc .\\README.md', 'type .\\README.md', 'cat .\\README.md', 'cpi .\\README.md x', 'copy .\\README.md x', 'more .\\README.md'];

test('the PowerShell tool refuses a backslash path to a .env file for every reader', (t) => {
  const cwd = project(t);
  for (const cmd of DENY) assert.ok(policy.bashDenial(cmd, { cwd, powershell: true }), 'must deny: ' + cmd);
  for (const cmd of ALLOW) assert.equal(policy.bashDenial(cmd, { cwd, powershell: true }), null, 'must allow: ' + cmd);
});

test('the hook passes the PowerShell flag, so a PowerShell event is judged like PowerShell', async (t) => {
  const cwd = project(t);
  const ev = (tool_name, command) => ({ session_id: 's', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name, tool_input: { command }, tool_use_id: 'toolu_x' });
  for (const cmd of DENY) {
    const r = await runner.handle(adapter, ev('PowerShell', cmd), { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home: cwd });
    assert.equal(r.output.hookSpecificOutput.permissionDecision, 'deny', cmd);
  }
});

test('a backslash word is judged as a path only where something reads it', (t) => {
  const cwd = project(t);
  for (const cmd of ['Write-Output .\\.env', 'echo .\\.env', 'Write-Host .\\.env']) {
    assert.equal(policy.bashDenial(cmd, { cwd, powershell: true }), null, 'must allow: ' + cmd);
  }
});

// A host that reads a backslash as a separator (Windows) resolves .\.env to the file, one that does not (Linux) does not; the verdict
// must be the same on both. The path functions are made to read a backslash as a separator, and the platform is forced to win32.
function asWindows(t) {
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', { value: real, configurable: true }));
  const fix = (a) => (typeof a === 'string' ? a.replace(/\\/g, '/') : a);
  for (const fn of ['resolve', 'normalize', 'join', 'basename', 'dirname', 'relative']) {
    const orig = path[fn];
    t.mock.method(path, fn, (...args) => orig.apply(path, args.map(fix)));
  }
}

for (const forced of [false, true]) {
  test('the backslash verdicts are the same ' + (forced ? 'with the platform forced to win32' : 'on this host'), (t) => {
    const cwd = project(t);
    if (forced) asWindows(t);
    // The shell of a session works in the project, so $PWD names it.
    const pwd = process.env.PWD;
    process.env.PWD = cwd;
    t.after(() => { if (pwd === undefined) delete process.env.PWD; else process.env.PWD = pwd; });
    for (const cmd of DENY) assert.ok(policy.bashDenial(cmd, { cwd, powershell: true }), 'must deny: ' + cmd);
    for (const cmd of ALLOW) assert.equal(policy.bashDenial(cmd, { cwd, powershell: true }), null, 'must allow: ' + cmd);
    for (const cmd of ['Write-Output .\\.env', 'echo .\\.env', 'Write-Host .\\.env', 'write-output .\\.env', 'Write-Output "a" .\\.env']) {
      assert.equal(policy.bashDenial(cmd, { cwd, powershell: true }), null, 'must allow: ' + cmd);
    }
    for (const cmd of ["Write-Output '.\\.env'", 'Write-Output .\\README.md']) {
      assert.equal(policy.bashDenial(cmd, { cwd, powershell: true }), null, 'must allow: ' + cmd);
    }
    // A braced variable, a subexpression or a variable in the word can read the file: only a plain literal word is text.
    for (const cmd of ['Write-Output ${.\\.env}', 'Write-Host "${.\\.env}"', 'Write-Output $(gc .\\.env)', 'echo @(gc .\\.env)',
      'Write-Output "$PWD\\.env"', 'Write-Output ${' + cwd + '\\.env}', 'Write-Output (gc .\\.env)']) {
      assert.ok(policy.bashDenial(cmd, { cwd, powershell: true }), 'must deny: ' + cmd);
    }
    // Printing is not reading, but nothing that reads may slip through behind a print command.
    for (const cmd of [
      'Write-Output .\\.env | Copy-Item -Destination x', 'echo .\\.env | Get-Item | Get-Content', 'echo .\\.env | gi | gc',
      'echo .\\.env | % { gc $_ }', 'Write-Output .\\.env | cpi -Destination x', 'Write-Output .\\.env && gc .\\.env', 'Write-Output .\\.env & gc .\\.env',
      'Write-Output .\\.env\ngc .\\.env', 'Write-Output .\\.env > x', 'Write-Output .\\.env | Out-Null','Write-Output .\\.env | Get-Content .\\.env', 'Write-Output (gc .\\.env)', 'Write-Output $(gc .\\.env)', 'Write-Output gc .\\.env',
      'Write-Output .\\.env; cat .\\.env', 'Write-Output .\\.env | cpi .\\.env x']) {
      assert.ok(policy.bashDenial(cmd, { cwd, powershell: true }), 'must deny: ' + cmd);
    }
  });
}

// Join-Path splits a protected path across its operands: the joined path is judged, so no operand alone has to name the file.
// A named parameter takes its own place whatever the order it is written in.
const JOIN_DENY = [
  'Join-Path . .env', 'Join-Path -Path . -ChildPath .env', 'Join-Path $HOME .ssh\\id_ed25519', 'Join-Path ~ .ssh\\id_ed25519',
  'Join-Path ~\\.aws credentials', 'Join-Path ~ .aws\\credentials', 'Join-Path ~/.aws credentials',
  'Join-Path -Path ~ -ChildPath .aws -AdditionalChildPath credentials', 'Join-Path -ChildPath config -Path ~\\.kube',
  'Join-Path -Pa ~\\.kube -Ch config', 'Join-Path -Path:~\\.kube -ChildPath:config', 'Join-Path ~\\.kube config -Resolve',
  'gc (Join-Path ~\\.kube config)', 'gc (Join-Path -Path . -ChildPath .env)', '$p = Join-Path ~\\.aws credentials; gc $p',
  'Join-Path ~\\.aws credentials | gc',
];
const JOIN_ALLOW = ['Join-Path . README.md', 'Join-Path -Path . -ChildPath README.md', 'gc (Join-Path . README.md)', 'Join-Path docs README.md'];

for (const forced of [false, true]) {
  test('a path split across the operands of Join-Path is judged ' + (forced ? 'with the platform forced to win32' : 'on this host'), (t) => {
    const cwd = project(t);
    if (forced) asWindows(t);
    for (const ps of [true, false]) {
      for (const cmd of JOIN_DENY) assert.ok(policy.bashDenial(cmd, { cwd, powershell: ps }), 'must deny: ' + cmd + ' (powershell ' + ps + ')');
      for (const cmd of JOIN_ALLOW) assert.equal(policy.bashDenial(cmd, { cwd, powershell: ps }), null, 'must allow: ' + cmd + ' (powershell ' + ps + ')');
    }
  });
}

// The lone-print exemption belongs to the PowerShell tool: in a Bash command echo is another program, and a Bash command keeps the
// verdict it had (on Windows .\.env resolves to the file, so it stays refused there; on Linux it stays allowed).
test('a lone print of a backslash path is exempt only for the PowerShell tool', (t) => {
  const cwd = project(t);
  asWindows(t);
  for (const cmd of ['Write-Output .\\.env', 'echo .\\.env', 'Write-Host .\\.env']) {
    assert.equal(policy.bashDenial(cmd, { cwd, powershell: true }), null, 'PowerShell tool must allow: ' + cmd);
    assert.ok(policy.bashDenial(cmd, { cwd, powershell: false }), 'Bash tool must deny: ' + cmd);
    assert.ok(policy.bashDenial(cmd, { cwd }), 'no flag must deny: ' + cmd);
  }
});

test('a lone print of a backslash path stays allowed for the Bash tool on a host that reads a backslash as an escape', (t) => {
  const cwd = project(t);
  for (const cmd of ['echo .\\.env', 'Write-Output .\\.env']) assert.equal(policy.bashDenial(cmd, { cwd, powershell: false }), null, cmd);
});

// The exemption is judged on the whole command of the call: a command text handed in by the caller (a fragment of it, or a stale one)
// changes nothing, and a missing one does not make anything pass.
test('the lone-print exemption reads the whole command, not opts.cmdText', (t) => {
  const cwd = project(t);
  asWindows(t);
  const frag = 'Write-Output .\\.env';
  for (const cmd of ['Write-Output .\\.env | gc', 'Write-Output .\\.env; gc .\\.env', 'Write-Output .\\.env && cat .\\.env', 'pwsh -c "Write-Output .\\.env | gc"']) {
    assert.ok(policy.bashDenial(cmd, { cwd, powershell: true, cmdText: frag }), 'must deny with a fragment as cmdText: ' + cmd);
    assert.ok(policy.bashDenial(cmd, { cwd, powershell: true, cmdText: undefined }), 'must deny without cmdText: ' + cmd);
    assert.ok(policy.bashDenial(cmd, { cwd, powershell: true, cmdText: 5 }), 'must deny with a bad cmdText: ' + cmd);
  }
  assert.equal(policy.bashDenial(frag, { cwd, powershell: true, cmdText: 'gc .\\.env | x' }), null);
});

// The verdict differs with the flag, so this proves the flag reaches the policy through the adapter: a PowerShell event
// is judged like PowerShell, the same text in a Bash event is not.
test('the hook gives the PowerShell flag to the policy: the same lone print is judged differently per tool', async (t) => {
  const cwd = project(t);
  asWindows(t);
  const pwd = process.env.PWD;
  process.env.PWD = cwd;
  t.after(() => { if (pwd === undefined) delete process.env.PWD; else process.env.PWD = pwd; });
  const ev = (tool_name, command) => ({ session_id: 's', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name, tool_input: { command }, tool_use_id: 'toolu_x' });
  const decide = async (tool_name, cmd) => {
    const r = await runner.handle(adapter, ev(tool_name, cmd), { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home: cwd });
    return r.output && r.output.hookSpecificOutput && r.output.hookSpecificOutput.permissionDecision;
  };
  for (const cmd of ['Write-Output .\\.env', 'echo .\\.env', 'Write-Host .\\.env']) {
    assert.notEqual(await decide('PowerShell', cmd), 'deny', 'PowerShell event must allow: ' + cmd);
    assert.equal(await decide('Bash', cmd), 'deny', 'Bash event must deny: ' + cmd);
  }
  // The tool name is mapped to the lower-case tool by the adapter, so a PowerShell event with a pipeline keeps the read check.
  assert.equal(await decide('PowerShell', 'Write-Output .\\.env | gc'), 'deny');
  assert.equal(await decide('PowerShell', 'Join-Path ~\\.aws credentials'), 'deny');
  assert.notEqual(await decide('PowerShell', 'Join-Path . README.md'), 'deny');
});
