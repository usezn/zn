'use strict';

// Every way of spelling a path in a shell command, around every way of reading it: a .env file with values is
// refused in all of them, and an ordinary file spelled the same way is allowed in all of them.
// The cmd.exe and PowerShell read commands follow the same rule for every spelling that resolves on this platform.
// The Windows spellings (backslashes, drive letters, a %CD% root) and UNC shares are added; the ones that need
// Windows path resolution run on Windows only, where the file they name really exists.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('../lib/hooks/policy');
const { tempDir } = require('./helpers/tmp');

const WIN = process.platform === 'win32';

const SPELLINGS = [
  (p) => p,
  (p) => "'" + p + "'",
  (p) => '"' + p + '"',
  (p) => './' + p,
  (p) => "$'" + p + "'",
  (p) => p.replace(/\.env$/, ".e''nv").replace(/notes\.txt$/, "no''tes.txt"),
];

const READS = [
  (w) => 'cat ' + w,
  (w) => 'head -n 1 ' + w,
  (w) => 'cat <' + w,
  (w) => 'cat 0<' + w,
  (w) => 'true && cat ' + w,
  (w) => '{ cat ' + w + '; }',
  (w) => '(cat ' + w + ')',
  (w) => 'cat ' + w + ' | head',
  (w) => 'cd . && cat ' + w,
  (w) => 'dd if=' + w,
  (w) => 'grep KEY ' + w,
  (w) => 'cat ' + w + ' 2>/dev/null',
];

// The read commands of cmd.exe and Windows PowerShell. The parser only reads the words, so these run anywhere;
// `copy` reads the file it copies (as the CMD_READS below show), and PowerShell's aliases resolve to the cmdlets.
const WIN_READS = [
  (w) => 'type ' + w,
  (w) => 'more ' + w,
  (w) => 'copy ' + w + ' read.target',
  (w) => 'findstr KEY ' + w,
  (w) => 'cmd /c type ' + w,
  (w) => 'Get-Content ' + w,
  (w) => 'gc ' + w,
  (w) => 'Get-Content -Path ' + w,
  (w) => 'gc -LiteralPath ' + w,
  (w) => 'Select-String KEY -Path ' + w,
];

// Backslash spellings of a relative path, as cmd.exe and PowerShell take them.
const WIN_SPELLINGS = [
  (p) => p.split('/').join('\\'),
  (p) => '.\\' + p.split('/').join('\\'),
  (p) => '"' + p.split('/').join('\\') + '"',
];

function project(t) {
  const dir = tempDir(t, 'zn-forms-');
  fs.mkdirSync(path.join(dir, 'app1', 'inner'), { recursive: true });
  for (const d of ['', path.join('app1', 'inner')]) {
    fs.writeFileSync(path.join(dir, d, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
    fs.writeFileSync(path.join(dir, d, 'notes.txt'), 'hello\n');
  }
  return { cwd: dir, home: dir, env: {} };
}

test('a .env file with values is refused however the path is spelled and read', (t) => {
  const o = project(t);
  const missed = [];
  for (const p of ['.env', 'app1/inner/.env']) {
    for (const spell of SPELLINGS) {
      for (const read of READS) {
        const cmd = read(spell(p));
        if (!policy.bashDenial(cmd, o)) missed.push(cmd);
      }
    }
  }
  assert.deepEqual(missed, []);
});

test('an ordinary file spelled and read the same ways is allowed', (t) => {
  const o = project(t);
  const refused = [];
  for (const p of ['notes.txt', 'app1/inner/notes.txt']) {
    for (const spell of SPELLINGS) {
      for (const read of READS) {
        const cmd = read(spell(p));
        if (policy.bashDenial(cmd, o)) refused.push(cmd);
      }
    }
  }
  assert.deepEqual(refused, []);
});

// The same rule with the read commands of cmd.exe and PowerShell, on the relative paths that resolve anywhere.
test('cmd.exe and PowerShell read commands are refused for a .env file and allowed for an ordinary file', (t) => {
  const o = project(t);
  const missed = [];
  const refused = [];
  for (const p of ['.env', 'app1/inner/.env']) {
    for (const read of WIN_READS) {
      const cmd = read(p);
      if (!policy.bashDenial(cmd, o)) missed.push(cmd);
    }
  }
  for (const p of ['notes.txt', 'app1/inner/notes.txt']) {
    for (const read of WIN_READS) {
      const cmd = read(p);
      if (policy.bashDenial(cmd, o)) refused.push(cmd);
    }
  }
  assert.deepEqual(missed, [], 'a .env file with values is refused');
  assert.deepEqual(refused, [], 'an ordinary file is allowed');
});

test('a .env file is refused however a Windows shell spells and reads it', { skip: !WIN && 'Windows path spellings' }, (t) => {
  const o = project(t);
  const missed = [];
  for (const p of ['.env', 'app1/inner/.env']) {
    const abs = '"' + path.join(o.cwd, ...p.split('/')) + '"';
    for (const spell of WIN_SPELLINGS) {
      for (const read of WIN_READS) {
        const cmd = read(spell(p));
        if (!policy.bashDenial(cmd, o)) missed.push(cmd);
      }
    }
    for (const read of WIN_READS) {
      const cmd = read(abs);
      if (!policy.bashDenial(cmd, o)) missed.push(cmd);
    }
  }
  assert.deepEqual(missed, []);
});

test('an ordinary file spelled and read the Windows ways is allowed', { skip: !WIN && 'Windows path spellings' }, (t) => {
  const o = project(t);
  const refused = [];
  for (const p of ['notes.txt', 'app1/inner/notes.txt']) {
    const abs = '"' + path.join(o.cwd, ...p.split('/')) + '"';
    for (const spell of WIN_SPELLINGS) {
      for (const read of WIN_READS) {
        const cmd = read(spell(p));
        if (policy.bashDenial(cmd, o)) refused.push(cmd);
      }
    }
    for (const read of WIN_READS) {
      const cmd = read(abs);
      if (policy.bashDenial(cmd, o)) refused.push(cmd);
    }
  }
  assert.deepEqual(refused, []);
});

// A .env reached through a path zn cannot follow (a UNC share or an extended-length path, a %CD% root) cannot be
// read and checked, so the name itself is refused like a .env path built while the command runs. An ordinary
// file on the same path is left alone. No file is needed, so this runs on every platform.
test('a .env reached through a UNC share, an extended path or %CD% is refused', (t) => {
  const o = project(t);
  const missed = [];
  const refused = [];
  const dotenv = ['\\\\servidor\\share\\.env', '\\\\servidor\\share\\app1\\.env', '\\\\?\\C:\\ruta\\.env',
    '\\\\?\\C:\\ruta\\app1\\.env', '%CD%\\.env', '"%CD%\\.env"', '%CD%\\app1\\.env'];
  const ordinary = ['\\\\servidor\\share\\notes.txt', '\\\\?\\C:\\ruta\\notes.txt', '%CD%\\notes.txt', '"%CD%\\notes.txt"'];
  for (const p of dotenv) {
    for (const read of WIN_READS) {
      const cmd = read(p);
      if (!policy.bashDenial(cmd, o)) missed.push(cmd);
    }
  }
  for (const p of ordinary) {
    for (const read of WIN_READS) {
      const cmd = read(p);
      if (policy.bashDenial(cmd, o)) refused.push(cmd);
    }
  }
  assert.deepEqual(missed, [], 'a .env through a path zn cannot check is refused');
  assert.deepEqual(refused, [], 'an ordinary file is allowed');
});

test('decoding $-quoting stays linear on long input', () => {
  for (const body of ['\\'.repeat(100000), '\\x'.repeat(50000), "\\'".repeat(50000)]) {
    const t0 = process.hrtime.bigint();
    policy._decodeAnsiC("cat $'" + body + "'");
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1500, 'too slow');
  }
});
