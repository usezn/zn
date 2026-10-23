'use strict';

process.env.ZN_STATS = 'off';

// Two Windows spellings of a protected file: an NTFS alternate data stream name (`credentials::$DATA`) and a cmd.exe
// or PowerShell redirect written with an unquoted drive path (`echo x> C:\Users\alice\.claude\settings.json`).

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

function asWindows(fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', real); }
}

const HOME = 'C:\\Users\\alice';
const O = { cwd: 'C:\\Users\\alice\\proj', home: HOME, env: {} };

const STREAMS = ['::$DATA', ':secret', ':secret:$DATA', '::$data'];
const FILES = [
  ['C:\\Users\\alice\\.aws\\credentials', 'credential'],
  ['C:\\Users\\alice\\proj\\.env', 'dotenv'],
  ['C:\\Users\\alice\\.ssh\\id_rsa', 'credential'],
  ['C:\\Users\\alice\\.claude\\settings.json', 'agent_config'],
];

test('an alternate data stream names the protected file itself (win32)', () => {
  asWindows(() => {
    const missed = [];
    for (const [file, kind] of FILES) {
      for (const ads of STREAMS) {
        const c = policy.classifyPath(file + ads, O);
        if (!c || c.kind !== kind) missed.push(file + ads + ' -> ' + (c && c.kind));
      }
    }
    assert.deepEqual(missed, []);
  });
});

test('a stream on a folder name still reaches the file inside it (win32)', () => {
  asWindows(() => {
    const c = policy.classifyPath('C:\\Users\\alice\\.aws::$INDEX_ALLOCATION\\credentials', O);
    assert.ok(c && c.kind === 'credential');
  });
});

test('slash spellings and a relative path with a stream are classified (win32)', () => {
  asWindows(() => {
    assert.ok(policy.classifyPath('C:/Users/alice/.aws/credentials::$DATA', O));
    assert.ok(policy.classifyPath('.env::$DATA', { ...O, cwd: 'C:\\Users\\alice\\proj' }));
  });
});

test('the explicit ::$DATA suffix is dropped on other platforms too', () => {
  const o = { cwd: '/work/proj', home: '/home/alice', env: {} };
  const c = policy.classifyPath('/home/alice/.aws/credentials::$DATA', o);
  assert.ok(c && c.kind === 'credential');
  // A colon is a legal name character there: another suffix is a different file.
  assert.equal(policy.classifyPath('/home/alice/notes/todo.txt:v1', o), null);
});

test('benign paths with a colon are unchanged (win32)', () => {
  asWindows(() => {
    for (const p of ['C:\\x\\notes.txt', 'C:\\Users\\alice\\proj\\src\\app.js', 'D:\\data\\report.csv', 'C:/x/notes.txt', 'C:notes.txt']) {
      assert.equal(policy.classifyPath(p, O), null, p);
    }
    // The drive letter itself is not read as a stream.
    assert.ok(policy.classifyPath('C:\\Users\\alice\\.aws\\credentials', O));
  });
});

test('a Read of a stream spelling is refused (win32)', () => {
  asWindows(() => {
    for (const p of ['C:\\Users\\alice\\.aws\\credentials::$DATA', 'C:\\Users\\alice\\proj\\.env::$DATA']) {
      assert.ok(policy.bashDenial('type ' + p, O), p);
    }
  });
});

const CONFIG = 'C:\\Users\\alice\\.claude\\settings.json';
const DENIED = [
  'echo x> ' + CONFIG,
  'echo x>> ' + CONFIG,
  'echo x>' + CONFIG,
  'echo x>>' + CONFIG,
  'echo x > ' + CONFIG,
  'echo x >' + CONFIG,
  'echo {} 2> ' + CONFIG,
  'echo x 1>' + CONFIG,
  'echo x> C:\\Users\\alice\\.codex\\config.toml',
  '"x" | Out-File ' + CONFIG,
  'Out-File -FilePath ' + CONFIG + ' -InputObject x',
  'Set-Content ' + CONFIG + ' x',
  'Set-Content -Path ' + CONFIG + ' -Value x',
  'echo x *> ' + CONFIG,
  'echo x>$env:USERPROFILE\\.claude\\settings.json',
  'echo x>%USERPROFILE%\\.claude\\settings.json',
];

test('a redirect to an agent config written as a drive path is refused', () => {
  const missed = [];
  for (const cmd of DENIED) if (!policy.bashDenial(cmd, O)) missed.push(cmd);
  assert.deepEqual(missed, []);
});

test('the same on win32', () => {
  asWindows(() => {
    const missed = [];
    for (const cmd of DENIED) if (!policy.bashDenial(cmd, O)) missed.push(cmd);
    assert.deepEqual(missed, []);
  });
});

test('a redirect glued to a word is a redirect in bash too', () => {
  const o = { cwd: '/work/proj', home: '/home/alice', env: {} };
  assert.ok(policy.bashDenial('echo x> ~/.claude/settings.json', o));
  assert.ok(policy.bashDenial('echo x>>/home/alice/.claude/settings.json', o));
  assert.ok(policy.bashDenial('echo x>/home/alice/.claude/settings.json', o));
});

test('benign redirects stay allowed', () => {
  for (const cmd of [
    'echo x> C:\\temp\\x.txt',
    'echo x>C:\\temp\\x.txt',
    'echo x>> C:\\Users\\alice\\proj\\build.log',
    'dir > C:\\Users\\alice\\proj\\out.txt',
    'echo x 2>&1',
    'Set-Content C:\\temp\\x.txt x',
    '"x" | Out-File C:\\temp\\x.txt',
  ]) {
    const o = { cwd: 'C:\\Users\\alice\\proj', home: HOME, env: {} };
    assert.equal(policy.bashDenial(cmd, o), null, cmd);
  }
});

// A redirect glued to the word before it: the word before it may be quoted, and may itself be a file that is read.
const POSIX_O = { cwd: '/work/proj', home: '/home/alice', env: { HOME: '/home/alice' } };
const GLUED_CONFIG = '~/.claude/settings.json';
const GLUED_DENIED = [
  "echo '{}'>" + GLUED_CONFIG,
  'echo "x">' + GLUED_CONFIG,
  'echo "x">>' + GLUED_CONFIG,
  'echo x"y">' + GLUED_CONFIG,
  'echo "a b">/home/alice/.claude/settings.json',
  "echo 'a>b'>" + GLUED_CONFIG,
  'echo x>"' + GLUED_CONFIG.replace('~', '$HOME') + '"',
  'cat /home/alice/.ssh/id_rsa>x',
  'cat /home/alice/.ssh/id_rsa>>x',
  'cat ~/.zn/run/session.key>x',
  'cat ~/.zn/run/session.key>>x',
  'cat ~/.aws/credentials>out.txt',
  'cp ~/.aws/credentials>x .',
  'cat "/home/alice/.ssh/id_rsa">x',
];

test('a quoted word or a secret file glued to a redirect is still checked (bash)', () => {
  const missed = GLUED_DENIED.filter((cmd) => !policy.bashDenial(cmd, POSIX_O));
  assert.deepEqual(missed, []);
});

test('the same quoted glued redirects on win32', () => {
  asWindows(() => {
    const o = { cwd: 'C:\\Users\\alice\\proj', home: HOME, env: { USERPROFILE: HOME } };
    const cmds = [
      'echo "x">' + CONFIG,
      "echo '{}'>$env:USERPROFILE\\.claude\\settings.json",
      'echo "x">>' + CONFIG,
      'echo x"y">' + CONFIG,
    ];
    const missed = cmds.filter((cmd) => !policy.bashDenial(cmd, o));
    assert.deepEqual(missed, []);
  });
});

test('only an unquoted > is the redirect', () => {
  assert.equal(policy.bashDenial("echo 'a>b'>out.txt", POSIX_O), null);
  assert.equal(policy.bashDenial('echo "a>b">out.txt', POSIX_O), null);
  assert.ok(policy.bashDenial("echo 'a>b'>" + GLUED_CONFIG, POSIX_O));
});

test('benign glued and quoted operators stay allowed (bash)', () => {
  for (const cmd of [
    'echo hi>out.txt',
    "node -e '(x)=>x'",
    'echo x>&2',
    "awk '$1>5' data.txt",
    'git log --format=%h->%s',
    '[[ a>b ]] && echo ok',
    "echo '>'",
    'echo "x">out.txt',
    "echo '{}'>out.json",
    'cat /home/alice/proj/a.txt>b.txt',
    'exec 3>fd.txt',
    'echo "a b">notes.txt',
  ]) assert.equal(policy.bashDenial(cmd, POSIX_O), null, cmd);
});

test('benign PowerShell and cmd operators stay allowed (win32)', () => {
  asWindows(() => {
    const o = { cwd: 'C:\\Users\\alice\\proj', home: HOME, env: { USERPROFILE: HOME } };
    for (const cmd of ['cmd 2>$null', 'echo x>NUL', 'echo "x">C:\\temp\\x.txt', 'echo x 2>&1']) {
      assert.equal(policy.bashDenial(cmd, o), null, cmd);
    }
  });
});
