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
