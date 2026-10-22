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
  for (const d of ['', 'app1', path.join('app1', 'inner')]) {
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

// A drive-relative path (C:.env, C:app1\.env) or a profile variable ($env:USERPROFILE, %USERPROFILE%) names the
// same real file once Windows expands it, so a .env behind one is refused like the plain path. On POSIX "\" is
// not a separator and %VARS% are not expanded, so this runs in the Windows checks job.
test('a .env named through a drive-relative or profile path is refused on Windows', { skip: !WIN && 'Windows path spellings' }, (t) => {
  const o = project(t);
  const drive = o.cwd.slice(0, 2); // "C:" of the folder the test writes in.
  const missed = [];
  const refused = [];
  const dotenv = [drive + '.env', drive + 'app1\\.env', drive + 'app1\\inner\\.env',
    '$env:USERPROFILE\\.env', '"$env:USERPROFILE\\.env"', '%USERPROFILE%\\.env', '"%USERPROFILE%\\.env"'];
  const ordinary = [drive + 'notes.txt', drive + 'app1\\notes.txt',
    '$env:USERPROFILE\\notes.txt', '%USERPROFILE%\\notes.txt'];
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
  assert.deepEqual(missed, [], 'a .env behind a drive-relative or profile path is refused');
  assert.deepEqual(refused, [], 'an ordinary file is allowed');
});

// A .env reached through a path zn cannot follow (a UNC share or an extended-length path, a %CD% root) cannot be
// read and checked, so the name itself is refused like a .env path built while the command runs. An ordinary
// file on the same path is left alone. No file is needed, so this runs on every platform.
test('a .env reached through a UNC share, an extended path or %CD% is refused', (t) => {
  const o = project(t);
  const missed = [];
  const refused = [];
  const dotenv = ['\\\\server\\share\\.env', '\\\\server\\share\\app1\\.env', '\\\\?\\C:\\path\\.env',
    '\\\\?\\C:\\path\\app1\\.env', '%CD%\\.env', '"%CD%\\.env"', '%CD%\\app1\\.env'];
  const ordinary = ['\\\\server\\share\\notes.txt', '\\\\?\\C:\\path\\notes.txt', '%CD%\\notes.txt', '"%CD%\\notes.txt"'];
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

// A drive-letter path (C:\Users\example\proj\.env, C:/Users/example/proj/.env) on a host that is not Windows does not
// resolve as typed. With a /mnt/<drive> mount (WSL) it is mapped to /mnt/<drive>/... and checked like any other path;
// without the mount zn cannot follow it, so a .env named that way is refused. The mount folder is injected (mntRoot),
// so these tests do not depend on the host. Windows resolves drive letters natively and is left unchanged.
const DRIVE_FORMS = [
  (p) => p,
  (p) => p.replace(/\\/g, '/'),
  (p) => '"' + p + '"',
  (p) => "'" + p.replace(/\\/g, '/') + "'",
];
const DRIVE_READS = [(w) => 'cat ' + w, (w) => 'type ' + w, (w) => 'cmd /c type ' + w, (w) => 'Get-Content -Path ' + w, (w) => 'grep KEY ' + w];

test('a drive-letter .env is mapped to /mnt/<drive> and checked when the mount exists', { skip: WIN && 'Windows resolves drive letters itself' }, (t) => {
  const o = project(t);
  const mnt = tempDir(t, 'zn-mnt-');
  const proj = path.join(mnt, 'c', 'Users', 'example', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'hello\n');
  fs.mkdirSync(path.join(mnt, 'c', 'Users', 'example', 'safe'), { recursive: true });
  fs.writeFileSync(path.join(mnt, 'c', 'Users', 'example', 'safe', '.env'), 'EXAMPLE_API_KEY=__ZN_EXAMPLE_API_KEY__\n');
  const opts = { ...o, mntRoot: mnt };
  const missed = [];
  const refused = [];
  for (const form of DRIVE_FORMS) {
    for (const read of DRIVE_READS) {
      const bad = read(form('C:\\Users\\example\\proj\\.env'));
      if (!policy.bashDenial(bad, opts)) missed.push(bad);
      for (const ok of ['C:\\Users\\example\\proj\\notes.txt', 'C:\\Users\\example\\safe\\.env', 'C:\\Users\\example\\nothing\\.env']) {
        const cmd = read(form(ok));
        if (policy.bashDenial(cmd, opts)) refused.push(cmd);
      }
    }
  }
  assert.deepEqual(missed, [], 'a .env with values behind a drive letter is refused');
  assert.deepEqual(refused, [], 'an ordinary, shadowed or missing file behind a drive letter is allowed');
});

test('a drive-letter .env is refused when there is no /mnt/<drive> mount to follow', { skip: WIN && 'Windows resolves drive letters itself' }, (t) => {
  const o = project(t);
  const opts = { ...o, mntRoot: tempDir(t, 'zn-nomnt-') };
  const missed = [];
  const refused = [];
  for (const form of DRIVE_FORMS) {
    for (const read of DRIVE_READS) {
      const bad = read(form('D:\\Users\\example\\proj\\.env'));
      const deny = policy.bashDenial(bad, opts);
      if (!deny || !/cannot check/.test(deny)) missed.push(bad);
      const cmd = read(form('D:\\Users\\example\\proj\\notes.txt'));
      if (policy.bashDenial(cmd, opts)) refused.push(cmd);
    }
  }
  assert.deepEqual(missed, [], 'a .env behind a drive letter zn cannot follow is refused');
  assert.deepEqual(refused, [], 'an ordinary file behind a drive letter is allowed');
});

test('decoding $-quoting stays linear on long input', () => {
  for (const body of ['\\'.repeat(100000), '\\x'.repeat(50000), "\\'".repeat(50000)]) {
    const t0 = process.hrtime.bigint();
    policy._decodeAnsiC("cat $'" + body + "'");
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1500, 'too slow');
  }
});
