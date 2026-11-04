'use strict';
process.env.ZN_STATS = 'off';
// PowerShell reads every path of a comma list, so `cat .env.example,.env` reads the real .env too. The hook judges
// each path of the list like a single read. In bash a,b is one file name. Values are fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('../lib/hooks/policy');
const { tempDir } = require('./helpers/tmp');

function project(t) {
  const base = path.join(os.homedir(), 'tmpwork');
  fs.mkdirSync(base, { recursive: true });
  const dir = tempDir(t, 'zn-pslist-', base);
  fs.writeFileSync(path.join(dir, '.env'), 'API_TOKEN=fake-not-a-real-secret-value-0000\n');
  fs.writeFileSync(path.join(dir, '.env.example'), 'API_TOKEN=\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# readme\n');
  return dir;
}

const DENY = [
  'cat .env.example,.env', 'gc .env.example,.env', 'type .env.example,.env',
  'cat .env.example, .env', 'gc .env.example, .env', 'type .env.example, .env',
  "cat '.env.example','.env'", "gc '.env.example','.env'", "type '.env.example','.env'",
  "cat @('.env.example','.env')", "gc @('.env.example','.env')", "type @('.env.example','.env')",
  'Get-Content .env.example,.env', 'Select-String -Path .env.example,.env -Pattern TOKEN',
  'gc ./.env.example,./.env', 'gc dir/../.env.example,dir/../.env',
  // A list that is split by spaces or written inside plain brackets.
  'gc .env.example ,.env', 'gc .env.example , .env', 'gc -Path .env.example ,.env', 'gc .env ,.env.example',
  'gc (".env.example",".env")', "gc ('.env.example','.env')", 'gc (".env.example" , ".env")', 'gc ( ".env.example" , ".env" )',
  'gc -Path (".env.example",".env")', "gc -Path ('.env.example','.env')", 'gc -Path ".env.example",".env"',
  "gc -Path '.env.example' ,'.env'", 'Get-Content (".env.example",".env")', 'Select-String -Path (".env.example",".env") -Pattern TOKEN',
  'cat (".env.example",".env")', "type ('.env.example', '.env')", 'gc ./.env.example ,./.env',
  // PowerShell on Windows reads a backslash as a separator, so the path is judged with "/" too.
  'gc .\\.env', "gc '.\\.env'", 'gc ".\\.env"', 'gc .\\.env.example,.\\.env',
];
const ALLOW = ['gc (".env.example","README.md")', "gc ('.env.example','README.md')", 'gc README.md ,.env.example', 'gc .env.example ,README.md',
  'gc -Path .env.example ,README.md', 'gc .\\.env.example', 'gc ./.env.example', 'gc dir/../.env.example', 'gc .env.example', 'cat .env.example', 'gc .env.example,README.md', 'cat .env.example, README.md'];

for (const ps of [true, false]) {
  test('PowerShell list reads of a real .env are blocked (powershell: ' + ps + ')', (t) => {
    const cwd = project(t);
    for (const cmd of DENY) {
      // Without the PowerShell tool flag, only the PowerShell-only readers are read as lists.
      if (!ps && /^(?:cat|type) /.test(cmd)) continue;
      assert.ok(policy.bashDenial(cmd, { cwd, powershell: ps }), 'must deny: ' + cmd);
    }
  });
}

test('a template alone or with an ordinary file stays allowed', (t) => {
  const cwd = project(t);
  for (const cmd of ALLOW) assert.equal(policy.bashDenial(cmd, { cwd, powershell: true }), null, cmd);
});

test('in bash a comma word is one file name', (t) => {
  const cwd = project(t);
  assert.equal(policy.bashDenial('cat .env.example,.env', { cwd }), null);
});
