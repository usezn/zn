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
