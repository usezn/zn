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

// PowerShell binds a value to a parameter with a colon: gc -Path:.env reads the same file as gc -Path .env.
// -Lit and -P are the short forms of -LiteralPath and -Path. The parser only reads the words, so this runs anywhere.
const PS_COLON_READS = [
  (w) => 'gc -Path:' + w,
  (w) => 'gc -LiteralPath:' + w,
  (w) => 'Get-Content -Path:' + w,
  (w) => 'Get-Content -LiteralPath:' + w,
  (w) => 'Get-Content -Lit:' + w,
  (w) => 'Get-Content -P:' + w,
  (w) => 'Get-Content -Raw -Path:' + w,
  (w) => 'cat -Path:' + w,
  (w) => 'type -LiteralPath:' + w,
  (w) => 'Select-String KEY -Path:' + w,
  (w) => 'Select-String -Path:' + w + ' -Pattern KEY',
  (w) => 'powershell -Command "gc -Path:' + w + '"',
];

test('a .env file read with a PowerShell colon parameter is refused and an ordinary file is allowed', (t) => {
  const o = project(t);
  const missed = [];
  const refused = [];
  for (const p of ['.env', 'app1/inner/.env', "'.env'", '"app1/inner/.env"', './.env']) {
    for (const read of PS_COLON_READS) {
      const cmd = read(p);
      if (!policy.bashDenial(cmd, o)) missed.push(cmd);
    }
  }
  for (const p of ['notes.txt', 'app1/inner/notes.txt', 'readme.md', '.env.example', "'notes.txt'", './notes.txt']) {
    for (const read of PS_COLON_READS) {
      const cmd = read(p);
      if (policy.bashDenial(cmd, o)) refused.push(cmd);
    }
  }
  // Other colon parameters carry no secret file.
  for (const cmd of ['Get-ChildItem -Path:. -Recurse', 'Get-Content -Path:notes.txt -Tail:5', 'Get-Content -Path:notes.txt -TotalCount:5',
    'Set-Location -Path:app1', 'Get-Content notes.txt -Encoding:UTF8']) {
    if (policy.bashDenial(cmd, o)) refused.push(cmd);
  }
  assert.deepEqual(missed, [], 'a .env behind a colon parameter is refused');
  assert.deepEqual(refused, [], 'an ordinary file is allowed');
});

// cmd.exe with delayed expansion (cmd /v:on) writes a variable as !NAME!, like %NAME% without it. A variable zn cannot
// expand that stands in front of a .env name may hold a folder, so the command is refused like a .env path built while
// it runs. No file is needed, so this runs on every platform.
test('a .env behind a cmd delayed expansion or another variable is refused and an ordinary file is allowed', (t) => {
  const o = project(t);
  const missed = [];
  const refused = [];
  const dotenv = ['!D!.env', '"!D!.env"', '!D!\\.env', '!D!/.env', 'app1/!D!.env', '!D!!E!.env', '!D!.env.local',
    '%D%.env', '"%D%.env"', '%D%.env.local', '$D.env', '${D}.env',
    // cmd modifiers: a substring or a replacement of the variable
    '!D:~0!.env', '%D:~0,99%.env', '!D:x=y!.env', '%D:x=y%.env', '"%D:~0,99%.env"', '!D:~0,99!.env.local', '%D:~-1%.env'];
  const ordinary = ['!D!notes.txt', '%D%notes.txt', '!D!', 'app1/!D!', '!D!.env.example', '%D%.env.example', '!D!.environment', '$D.envrc',
    '!D:~0!notes.txt', '%D:~0,99%notes.txt', '!D:x=y!notes.txt', '%D:x=y%notes.txt', '!D:~0!', '%D:~0,99%.env.example', '!D:~0!.environment'];
  const reads = [...WIN_READS, ...PS_COLON_READS, (w) => 'cmd /v:on /c type ' + w, (w) => 'cmd /v:on /c "type ' + w + '"'];
  for (const p of dotenv) {
    for (const read of reads) {
      const cmd = read(p);
      if (!policy.bashDenial(cmd, o)) missed.push(cmd);
    }
  }
  for (const p of ordinary) {
    for (const read of reads) {
      const cmd = read(p);
      if (policy.bashDenial(cmd, o)) refused.push(cmd);
    }
  }
  assert.deepEqual(missed, [], 'a .env behind a variable is refused');
  assert.deepEqual(refused, [], 'an ordinary file is allowed');
});

test('a delayed expansion variable is read from the environment and from the command like %NAME% is', (t) => {
  const o = project(t);
  const known = { ...o, env: { D: 'app1/' } };
  // D holds a folder with a .env file: the command reads app1/.env or app1/notes.txt.
  assert.ok(policy.bashDenial('type !D!.env', known), 'type !D!.env');
  assert.ok(policy.bashDenial('type %D%.env', known), 'type %D%.env');
  assert.ok(policy.bashDenial('cmd /v:on /c type !D!.env', known), 'cmd /v:on /c type !D!.env');
  assert.equal(policy.bashDenial('type !D!notes.txt', known), null, 'type !D!notes.txt');
  assert.equal(policy.bashDenial('type %D%notes.txt', known), null, 'type %D%notes.txt');
  // The command sets the variable itself.
  assert.ok(policy.bashDenial('cmd /v:on /c "set D=app1/& type !D!.env"', o), 'set then read the .env');
  assert.ok(policy.bashDenial('set D=app1/ && type !D!.env', o), 'set then read the .env, plain');
  assert.equal(policy.bashDenial('set D=app1/ && type !D!notes.txt', o), null, 'set then read an ordinary file');
  assert.equal(policy.bashDenial('set D=notes && type !D!.txt', o), null, 'a variable that makes an ordinary name');
  // A value that holds another variable zn cannot expand is unknown, so its .env is refused.
  assert.ok(policy.bashDenial('set D=!E! && type !D!.env', o), 'a value that holds another variable');
});

test('decoding $-quoting stays linear on long input', () => {
  for (const body of ['\\'.repeat(100000), '\\x'.repeat(50000), "\\'".repeat(50000)]) {
    const t0 = process.hrtime.bigint();
    policy._decodeAnsiC("cat $'" + body + "'");
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1500, 'too slow');
  }
});

// A word that is a PowerShell colon value and also a --name=value word: both readings are judged (a regression of the colon branch).
test('a colon word that holds an equals sign refuses a .env in either reading', (t) => {
  const o = project(t);
  const missed = [];
  const refused = [];
  for (const cmd of ['tool -X:a=.env', 'tool -p:EnvFile=.env', 'cat -X:y=.env', 'tool -X:a=app1/.env', 'tool "-p:EnvFile=.env"', 'tool -X:a=b=.env',
    'gc -Path:.env', 'tool --kubeconfig=.env', 'tool -X:a=\'.env\'']) {
    if (!policy.bashDenial(cmd, o)) missed.push(cmd);
  }
  for (const cmd of ['msbuild -p:Configuration=Release', 'dotnet build -p:Version=1.0', 'tool -X:a=notes.txt', 'tool -p:EnvFile=notes.txt', 'tool -X:a=.env.example',
    'gc -Path:notes.txt -Encoding:UTF8', 'robocopy . out /XF:x', 'tool -X:a=b']) {
    if (policy.bashDenial(cmd, o)) refused.push(cmd);
  }
  assert.deepEqual(missed, [], 'a .env behind a colon word with an equals sign is refused');
  assert.deepEqual(refused, [], 'an ordinary value is allowed');
});

test('a cmd variable with a modifier is never expanded, even when the variable is known', (t) => {
  const o = project(t);
  const known = { ...o, env: { D: 'app1/', E: 'zzz' } };
  assert.ok(policy.bashDenial('type !D:~0!.env', known), 'type !D:~0!.env');
  assert.ok(policy.bashDenial('type %D:~0,99%.env', known), 'type %D:~0,99%.env');
  assert.ok(policy.bashDenial('cmd /v:on /c type !D:x=y!.env', known), 'cmd /v:on /c type !D:x=y!.env');
  assert.equal(policy.bashDenial('type %D:~0,99%notes.txt', known), null, 'an ordinary file behind a modifier');
  assert.equal(policy.bashDenial('type !E:x=y!', known), null, 'a modifier alone');
  // The command sets the variable with a modifier in its value: unknown, so a .env behind it is refused.
  assert.ok(policy.bashDenial('set D=%E:~0,1% && type !D!.env', o), 'a value that holds a modified variable');
});

// The same forms on a Windows host: there a colon in a name starts an NTFS stream, which must not cut a cmd modifier off the variable.
function asWin(fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', desc);
  }
}

test('a cmd variable with a modifier before a .env name is refused on Windows too, and ordinary names stay allowed', (t) => {
  const o = project(t);
  const known = { ...o, env: { D: 'app1/' } };
  const missed = [];
  const refused = [];
  asWin(() => {
    for (const env of [o, known]) {
      for (const cmd of ['type !D:~0!.env', 'type %D:~0,99%.env', 'type !D:x=y!.env', 'type %D:x=y%.env', 'cmd /v:on /c type !D:~0!.env', 'type %D:a=b%.env',
        'type "!D:~0!.env"', 'type ".\\%D:~0,99%.env"', 'copy !D:~0,1!.env x.txt', 'type < %D:x=y%.env', 'Get-Content -Path:%D:~0,99%.env']) {
        if (!policy.bashDenial(cmd, env)) missed.push(cmd);
      }
      for (const cmd of ['type !D:~0!notes.txt', 'type %D:~0,99%notes.txt', 'type %D:x=y%.env.example', 'type notes.txt', 'echo %D:~0,2%']) {
        if (policy.bashDenial(cmd, env)) refused.push(cmd);
      }
    }
  });
  assert.deepEqual(missed, [], 'a .env behind a modified variable is refused on Windows');
  assert.deepEqual(refused, [], 'an ordinary file is allowed');
});
