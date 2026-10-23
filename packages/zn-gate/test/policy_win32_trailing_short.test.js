'use strict';

process.env.ZN_STATS = 'off';

// Windows drops trailing dots and spaces from a name and also opens a file by its 8.3 short name, so
// `settings.json.`, `"settings.json "` and `SETTIN~1.JSO` all name the protected file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('../lib/hooks/policy');
const { tempDir } = require('./helpers/tmp');

function asWindows(fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', real); }
}

const HOME = 'C:\\Users\\alice';
const O = { cwd: 'C:\\Users\\alice\\proj', home: HOME, env: {} };

// The Node test host is not Windows, so a short name (which needs the home folder to resolve) is tested with a
// posix-style layout while the platform flag still says win32. On a real Windows host the drive paths work the same.
// On a real Windows host path.resolve adds a drive, so there the same layout is written with one.
const REAL_WIN = process.platform === 'win32';
const L = (p) => (REAL_WIN ? 'C:' + p.split('/').join(String.fromCharCode(92)) : p);
const P = { cwd: L('/Users/alice/proj'), home: L('/Users/alice'), env: {} };
const SHORT_WRITE = [
  '/Users/alice/.claude/SETTIN~1.JSO',
  '/Users/alice/.claude/settin~1.jso',
  '/Users/alice/CLAUDE~1/settings.json',
  '/Users/alice/CLAUDE~1/SETTIN~1.JSO',
  '/Users/alice/.claude/SETTIN~2.JSO',
].map(L);
const SHORT_READ = ['/Users/alice/.aws/CREDEN~1', '/Users/alice/AWS~1/credentials', '/Users/alice/proj/ENV~1'].map(L);

const WRITE_TARGETS = [
  'C:\\Users\\alice\\.claude\\settings.json.',
  'C:\\Users\\alice\\.claude\\settings.json..',
  'C:\\Users\\alice\\.claude\\settings.json ',
  'C:\\Users\\alice\\.claude\\settings.json. .',
  'C:\\Users\\alice\\.claude.\\settings.json',
  'C:\\Users\\alice\\.claude \\settings.json',
];

const READ_TARGETS = [
  'C:\\Users\\alice\\.aws\\credentials.',
  'C:\\Users\\alice\\.aws\\credentials ',
  'C:\\Users\\alice\\.aws.\\credentials',
  'C:\\Users\\alice\\proj\\.env.',
  'C:\\Users\\alice\\proj\\.env ',
  'C:\\Users\\alice\\.ssh\\id_rsa.',
  'C:\\Users\\alice\\.ssh\\id_rsa..',
];

test('trailing dots and spaces name the protected file (classifyPath, win32)', () => {
  asWindows(() => {
    const missed = [];
    for (const p of WRITE_TARGETS) {
      const c = policy.classifyPath(p, O);
      if (!c || c.kind !== 'agent_config') missed.push(p + ' -> ' + (c && c.kind));
    }
    // A .env read is judged by its content, so it is covered by the classifyPath test above.
    for (const p of READ_TARGETS.filter((x) => !x.includes('.env'))) {
      if (!policy.classifyPath(p, O)) missed.push(p);
    }
    assert.deepEqual(missed, []);
  });
});

test('a write through a cmd redirect is refused for each spelling (win32)', () => {
  asWindows(() => {
    const allowed = [];
    for (const p of WRITE_TARGETS) {
      const bare = p.includes(' ') ? [] : ['echo x>' + p];
      for (const cmd of [...bare, 'echo x>"' + p + '"', 'echo x > "' + p + '"']) {
        if (!policy.bashDenial(cmd, O)) allowed.push(cmd);
      }
    }
    assert.deepEqual(allowed, []);
  });
});

test('a read is refused for each spelling (win32)', () => {
  asWindows(() => {
    const allowed = [];
    // A .env read is judged by its content, so it is covered by the classifyPath test above.
    for (const p of READ_TARGETS.filter((x) => !x.includes('.env'))) {
      const bare = p.includes(' ') ? [] : ['type ' + p];
      for (const cmd of [...bare, 'type "' + p + '"']) {
        if (!policy.bashDenial(cmd, O)) allowed.push(cmd);
      }
    }
    assert.deepEqual(allowed, []);
  });
});

test('an 8.3 short name of a protected file is protected (win32)', () => {
  asWindows(() => {
    for (const p of [...SHORT_WRITE, ...SHORT_READ]) assert.ok(policy.classifyPath(p, P), p);
    for (const p of SHORT_WRITE) {
      assert.ok(policy.bashDenial('echo x>' + p, P), p);
      assert.ok(policy.bashDenial('echo x>"' + p + '"', P), p);
    }
    for (const p of SHORT_READ) assert.ok(policy.bashDenial('type ' + p, P), p);
  });
});

test('a short name that cannot stand for a protected name stays allowed (win32)', () => {
  asWindows(() => {
    for (const p of ['/Users/alice/proj/PROGRA~1/app.exe', '/Users/alice/proj/README~1.TXT', '/Users/alice/notes~old.txt',
      '/Users/alice/proj/REPORT~1.DOC', '/Users/alice/.cache/BUILD~1'].map(L)) {
      assert.equal(policy.classifyPath(p, P), null, p);
    }
  });
});

test('ordinary names stay allowed (win32)', () => {
  asWindows(() => {
    const ok = [
      'C:\\temp\\a.txt.',
      'C:\\temp\\a.txt ',
      'C:\\Users\\alice\\notes~old.txt',
      'C:\\Users\\alice\\report~v2.docx',
      'C:\\Users\\alice\\proj\\src\\app.js',
      'C:\\Users\\alice\\proj\\a~b\\c.txt',
      'C:\\Users\\alice\\proj\\build~12',
      'C:\\Users\\alice\\proj\\..',
      'C:\\Users\\alice\\proj\\.',
      'C:\\Users\\alice\\proj\\...',
    ];
    for (const p of ok) assert.equal(policy.classifyPath(p, O), null, p);
    for (const p of ok.slice(0, 5)) assert.equal(policy.bashDenial('type "' + p + '"', O), null, p);
  });
});

test('posix keeps a trailing dot as a different file, and ~1 is a plain name', { skip: REAL_WIN && 'posix paths only' }, () => {
  const o = { cwd: '/work/proj', home: '/home/alice', env: {} };
  assert.equal(policy.classifyPath('/home/alice/.aws/credentials.', o), null);
  assert.equal(policy.classifyPath('/home/alice/.aws/CREDEN~1', o), null);
  assert.ok(policy.classifyPath('/home/alice/.claude/settings.json', o));
  assert.ok(policy.classifyPath('/home/alice/.aws/credentials', o));
});

test('very long segments stay linear (win32)', () => {
  asWindows(() => {
    const inputs = [
      'C:\\Users\\alice\\proj\\' + '.'.repeat(100000) + 'x',
      'C:\\Users\\alice\\proj\\' + 'a' + ' .'.repeat(50000),
      'C:\\Users\\alice\\proj\\' + 'a~1'.repeat(30000),
      'C:\\Users\\alice\\proj\\' + 'abcdef~1\\'.repeat(10000) + 'f',
      '/Users/alice/proj/' + 'abcdef~1/'.repeat(10000) + 'f',
    ];
    for (const p of inputs) {
      const t = Date.now();
      policy.classifyPath(p, p.startsWith('/') ? P : O);
      assert.ok(Date.now() - t < 2000, 'slow: ' + p.length + ' chars took ' + (Date.now() - t) + ' ms');
    }
  });
});

// A home folder or a temp folder with an 8.3 short name (C:\Users\RUNNER~1\...) is on every path under it: it must not
// make a plain file there look protected, so a shadowed .env stays readable and a plain one stays refused.
test('a short name in a parent folder behaves like the long name for a .env (win32)', (t) => {
  const base = tempDir(t, 'zn-short-');
  const home = path.join(base, 'ZNTST~1');
  const dir = path.join(home, 'AppData', 'Temp', 'x');
  fs.mkdirSync(dir, { recursive: true });
  const env = path.join(dir, '.env');
  const o = { cwd: dir, home, env: {} };
  asWindows(() => {
    fs.writeFileSync(env, 'AWS_ACCESS_KEY_ID=plain-text-example\nDEBUG=true\n');
    assert.ok(policy.readDenial(env, o), 'plain .env refused');
    fs.writeFileSync(env, 'AWS_ACCESS_KEY_ID=__ZN_AWS_ACCESS_KEY_ID__\nDEBUG=true\n');
    assert.equal(policy.readDenial(env, o), null, 'shadowed .env allowed');
    assert.equal(policy.readDenial(path.join(dir, '.env.example'), o), null);
    assert.equal(policy.classifyPath(path.join(dir, 'notes.txt'), o), null);
    assert.equal(policy.classifyPath(path.join(home, 'AppData', 'Temp', 'x', 'src.js'), o), null);
  });
});

// A glob as the last name under a short folder reads a plain .env too (cmd and PowerShell `*` match dot files).
test('a glob under a short-named folder keeps matching a plain .env (win32)', (t) => {
  const base = tempDir(t, 'zn-short-glob-');
  const home = path.join(base, 'ZNTST~1');
  const dir = path.join(home, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello\n');
  const env = path.join(dir, '.env');
  const o = { cwd: dir, home, env: {} };
  asWindows(() => {
    fs.writeFileSync(env, 'AWS_ACCESS_KEY_ID=plain-text-example\nDEBUG=true\n');
    for (const g of ['*', '.e*', '.env*', '?env']) {
      assert.ok(policy.bashDenial('type ' + dir + path.sep + g, o), 'type ' + g);
      assert.ok(policy.bashDenial('cat ' + dir + path.sep + g, o), 'cat ' + g);
    }
    assert.ok(policy.bashDenial('type ' + dir + path.sep + '*.txt', o) === null, '*.txt cannot match .env');
    fs.writeFileSync(env, 'AWS_ACCESS_KEY_ID=__ZN_AWS_ACCESS_KEY_ID__\nDEBUG=true\n');
    assert.equal(policy.bashDenial('type ' + dir + path.sep + '*.txt', o), null, 'shadowed .env, *.txt');
  });
});
