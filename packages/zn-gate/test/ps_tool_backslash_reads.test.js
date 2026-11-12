'use strict';
process.env.ZN_STATS = 'off';
// The PowerShell tool reads a backslash as a path separator (type .\.env, cp .\.env x), so a protected file named
// that way is refused for every reader and copier, not only for the PowerShell-only cmdlets. Values are fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const adapter = require('../lib/agents/claude-code');
const runner = require('../lib/hooks/runner');
const policy = require('../lib/hooks/policy');
const fakeEngine = require('./helpers/fake_engine');
const { createFakeVault } = require('./helpers/fake_vault');
const { tempDir } = require('./helpers/tmp');

const TOO_MANY_PATHS = 'zn: this command has too many paths for zn to check in time, so it was blocked. Next step: run it as several shorter commands, or tell the user.';

function project(t) {
  // A directory of its own under the system temp folder, removed when the test ends: nothing is written to the real home.
  const dir = tempDir(t, 'zn-psbs-');
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

// A lone print of a backslash path names the file only on a host that reads a backslash as a separator: on Windows .\.env is the
// protected file (refused, an accepted false positive), on Linux it is just an odd file name (allowed).
test('a lone print of a backslash path is judged by what the path is on this host', (t) => {
  const cwd = project(t);
  const onWindows = process.platform === 'win32';
  for (const cmd of ['Write-Output .\\.env', "Write-Output '.\\.env'", 'echo .\\.env', 'Write-Host .\\.env']) {
    const v = policy.bashDenial(cmd, { cwd, powershell: true });
    if (onWindows) assert.ok(v, 'must deny on Windows: ' + cmd); else assert.equal(v, null, 'must allow on this host: ' + cmd);
  }
  assert.equal(policy.bashDenial('Write-Output .\\README.md', { cwd, powershell: true }), null);
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
    // Forced win32: .\.env is the protected file, so even a lone print is refused (as before this change). On this host it is only an
    // odd file name, so it is allowed (also as before). A harmless path is allowed in both runs.
    for (const cmd of ['Write-Output .\\.env', "Write-Output '.\\.env'", 'echo .\\.env', 'Write-Host .\\.env', 'write-output .\\.env', 'Write-Output "a" .\\.env']) {
      const v = policy.bashDenial(cmd, { cwd, powershell: true });
      if (forced || process.platform === 'win32') assert.ok(v, 'must deny: ' + cmd); else assert.equal(v, null, 'must allow: ' + cmd);
    }
    assert.equal(policy.bashDenial('Write-Output .\\README.md', { cwd, powershell: true }), null);
    // A braced variable, a subexpression or a variable in the word can read the file.
    for (const cmd of ['Write-Output ${.\\.env}', 'Write-Host "${.\\.env}"', 'Write-Output $(gc .\\.env)', 'echo @(gc .\\.env)',
      'Write-Output "$PWD\\.env"', 'Write-Output ${' + cwd + '\\.env}', 'Write-Output (gc .\\.env)']) {
      assert.ok(policy.bashDenial(cmd, { cwd, powershell: true }), 'must deny: ' + cmd);
    }
    // Nothing that reads may slip through behind a print command, on any platform.
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

// More Join-Path calls than zn judges, or a joined path too long to judge, is refused as a whole: a protected join after the
// harmless ones must never go unjudged.
const harmlessJoins = (n) => Array.from({ length: n }, (_, i) => 'Join-Path a' + (i + 1) + ' b;').join(' ');
for (const forced of [false, true]) {
  test('the Join-Path limits fail closed ' + (forced ? 'with the platform forced to win32' : 'on this host'), (t) => {
    const cwd = project(t);
    if (forced) asWindows(t);
    for (const ps of [true, false]) {
      const opts = { cwd, powershell: ps };
      for (const n of [31, 32, 33, 40, 100]) {
        assert.ok(policy.bashDenial(harmlessJoins(n) + ' gc (Join-Path ~\\.kube config)', opts), n + ' joins then a protected one must be denied (powershell ' + ps + ')');
      }
      // Without a protected join, a command over the limit is refused like any other command that has too many paths.
      for (const n of [33, 40, 100]) {
        assert.equal(policy.bashDenial(harmlessJoins(n), opts), TOO_MANY_PATHS, n + ' harmless joins are refused (powershell ' + ps + ')');
      }
      assert.equal(policy.bashDenial(harmlessJoins(5) + ' gc (Join-Path . README.md)', opts), null);
      // A joined path longer than 4096 characters is refused, not skipped.
      const long = 'x'.repeat(4100);
      assert.equal(policy.bashDenial('Join-Path ' + long + ' b', opts), TOO_MANY_PATHS, 'a joined path over 4096 characters is refused');
      assert.equal(policy.bashDenial('gc (Join-Path -Path . -ChildPath ' + long + ')', opts), TOO_MANY_PATHS);
    }
  });
}

// Named parameters out of slot order give two distinct joins per call (the slot order and the order as written), so 16 such calls
// fill the 32-path limit and a later protected join is refused; 15 such calls leave room for one more join.
const reorderedJoins = (n) => Array.from({ length: n }, (_, i) => 'Join-Path -ChildPath b' + (i + 1) + ' -Path a' + (i + 1)).join('; ');
for (const forced of [false, true]) {
  test('reordered named Join-Path parameters count toward the limit ' + (forced ? 'with the platform forced to win32' : 'on this host'), (t) => {
    const cwd = project(t);
    if (forced) asWindows(t);
    for (const ps of [true, false]) {
      const opts = { cwd, powershell: ps };
      assert.ok(policy.bashDenial(reorderedJoins(16) + '; gc (Join-Path -ChildPath config -Path ~\.kube)', opts), '16 reordered calls then a protected one must be denied (powershell ' + ps + ')');
      assert.equal(policy.bashDenial(reorderedJoins(15), opts), null, '15 reordered calls alone must be allowed (powershell ' + ps + ')');
      assert.equal(policy.bashDenial(reorderedJoins(15) + '; gc (Join-Path -ChildPath README.md -Path .)', opts), null, '15 reordered calls then a harmless one must be allowed (powershell ' + ps + ')');
    }
  });
}

// The Bash tool and the PowerShell tool agree on a lone print: it is judged only by what the path is on the host.
test('a lone print of a backslash path gets the same verdict in the Bash and the PowerShell tool', (t) => {
  const cwd = project(t);
  asWindows(t);
  for (const cmd of ['Write-Output .\\.env', 'echo .\\.env', 'Write-Host .\\.env']) {
    assert.ok(policy.bashDenial(cmd, { cwd, powershell: true }), 'PowerShell tool must deny on win32: ' + cmd);
    assert.ok(policy.bashDenial(cmd, { cwd, powershell: false }), 'Bash tool must deny on win32: ' + cmd);
  }
});

// The verdict differs with the flag, so this proves the flag reaches the policy through the adapter: a PowerShell event reads
// cat .\.env as a PowerShell path (refused), the same text in a Bash event is a bash word that names no protected file on Linux.
test('the hook gives the PowerShell flag to the policy: a PowerShell-only reading is judged per tool', async (t) => {
  const cwd = project(t);
  const ev = (tool_name, command) => ({ session_id: 's', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name, tool_input: { command }, tool_use_id: 'toolu_x' });
  const decide = async (tool_name, cmd) => {
    const r = await runner.handle(adapter, ev(tool_name, cmd), { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home: cwd });
    return r.output && r.output.hookSpecificOutput && r.output.hookSpecificOutput.permissionDecision;
  };
  for (const cmd of ['cat .\\.env', 'cp .\\.env x', 'type .\\.env']) {
    assert.equal(await decide('PowerShell', cmd), 'deny', 'PowerShell event must deny: ' + cmd);
    // A Windows host reads the backslash as a separator in either tool, so the difference only exists elsewhere.
    if (process.platform !== 'win32') assert.notEqual(await decide('Bash', cmd), 'deny', 'Bash event must allow: ' + cmd);
  }
  assert.equal(await decide('PowerShell', 'Write-Output .\\.env | gc'), 'deny');
  assert.equal(await decide('PowerShell', 'Join-Path ~\\.aws credentials'), 'deny');
  assert.notEqual(await decide('PowerShell', 'Join-Path . README.md'), 'deny');
});
