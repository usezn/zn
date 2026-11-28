'use strict';

process.env.ZN_STATS = 'off';

// Windows opens a file by its 8.3 short name (`SSH~1\ID_ED~1` is `.ssh\id_ed25519`), and a path that arrives
// JSON-escaped twice has doubled backslashes (`C:\\Users\\u\\.ssh\\id_work`). Both name the same protected file as the
// long, single-separator form. The paths are written with backslashes so the test is the same on the Linux job and on
// the windows-latest job; the platform flag is set to win32 for the Linux host.

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

function asWindows(fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', real); }
}

const BS = String.fromCharCode(92);
const O = { cwd: 'C:\\Users\\u\\proj', home: 'C:\\Users\\u', env: {} };

const SHORT_CREDENTIAL = [
  'C:\\Users\\u\\SSH~1\\ID_ED~1',
  'C:\\Users\\u\\ssh~1\\id_ed~1',
  'C:\\Users\\u\\SSH~1\\ID_W~1',
  'C:\\Users\\u\\SSH~1\\id_rsa',
  'C:\\Users\\u\\.ssh\\ID_ED~1',
  'C:\\Users\\u\\AWS~1\\credentials',
  'C:\\Users\\u\\AWS~1\\CREDEN~1',
  'C:/Users/u/SSH~1/ID_ED~1',
];
const SHORT_KEYFILE = ['C:\\Users\\u\\PRO~1\\SERV~1.PEM', 'C:\\Users\\u\\proj\\SERV~1.KEY'];
const DOUBLED = [
  'C:\\\\Users\\\\u\\\\.ssh\\\\id_work',
  'C:\\\\Users\\\\u\\\\.ssh\\\\id_rsa',
  'C:\\\\Users\\\\u\\\\.aws\\\\credentials',
  'C:\\\\Users\\\\u\\\\proj\\\\.env',
  'C:\\Users\\\\u\\.ssh\\\\id_work',
  '\\\\Users\\\\u\\\\.ssh\\\\id_work',
];
const LONG_FORMS = ['C:\\Users\\u\\.ssh\\id_work', 'C:\\Users\\u\\.ssh\\id_ed25519', 'C:\\Users\\u\\.aws\\credentials'];

test('the long forms are refused (control, win32)', () => {
  asWindows(() => {
    for (const p of LONG_FORMS) {
      assert.ok(policy.classifyPath(p, O), p);
      assert.ok(policy.readDenial(p, O), p);
    }
  });
});

test('an 8.3 short name of a protected file is classified like the long name (win32)', () => {
  asWindows(() => {
    const missed = [];
    for (const p of SHORT_CREDENTIAL) {
      const c = policy.classifyPath(p, O);
      if (!c || c.kind !== 'credential') missed.push(p + ' -> ' + (c && c.kind));
    }
    for (const p of SHORT_KEYFILE) {
      const c = policy.classifyPath(p, O);
      if (!c || c.kind !== 'keyfile') missed.push(p + ' -> ' + (c && c.kind));
    }
    assert.deepEqual(missed, []);
  });
});

test('a read of an 8.3 short name is refused, as a file tool and as a command (win32)', () => {
  asWindows(() => {
    const allowed = [];
    for (const p of SHORT_CREDENTIAL) {
      if (!policy.readDenial(p, O)) allowed.push('read ' + p);
      if (!policy.bashDenial('type "' + p + '"', O)) allowed.push('type ' + p);
      if (!policy.bashDenial('cat "' + p + '"', O)) allowed.push('cat ' + p);
    }
    assert.deepEqual(allowed, []);
  });
});

test('a doubled-backslash path is classified like the single-backslash one (win32)', () => {
  asWindows(() => {
    const missed = [];
    for (const p of DOUBLED) {
      const c = policy.classifyPath(p, O);
      if (!c) missed.push(p);
      if (!policy.readDenial(p, O) && !p.includes('.env')) missed.push('read ' + p);
      // A .env read is judged by its content, so classifyPath above covers it.
      if (!p.includes('.env') && !policy.bashDenial('type "' + p + '"', O)) missed.push('type ' + p);
    }
    assert.deepEqual(missed, []);
  });
});

test('a doubled-separator path is refused on a posix host too', () => {
  const o = { cwd: '/work/proj', home: '/home/u', env: {} };
  for (const p of ['/home/u//.ssh//id_work', '/home/u/.ssh///id_rsa', '/home/u//.aws//credentials']) {
    assert.ok(policy.classifyPath(p, o), p);
  }
  // ...and a backslash stays an ordinary name character there, so a short name is just a name.
  assert.equal(policy.classifyPath('/home/u/SSH~1/ID_ED~1', o), null);
});

test('ordinary short names and doubled separators stay allowed (win32)', () => {
  asWindows(() => {
    const ok = [
      'C:\\Users\\u\\PROGRA~1\\app.exe',
      'C:\\Users\\u\\proj\\README~1.TXT',
      'C:\\Users\\u\\proj\\REPORT~1.DOC',
      'C:\\Users\\u\\.cache\\BUILD~1',
      'C:\\\\Users\\\\u\\\\proj\\\\src\\\\app.js',
      'C:\\\\temp\\\\a.txt',
      'C:\\Users\\u\\notes~old.txt',
    ];
    for (const p of ok) {
      assert.equal(policy.classifyPath(p, O), null, p);
      assert.equal(policy.bashDenial('type "' + p + '"', O), null, p);
    }
  });
});

test('the same forms are written with real separators on the host (spot check)', () => {
  asWindows(() => {
    const p = ['C:', 'Users', 'u', 'SSH~1', 'ID_ED~1'].join(BS);
    assert.ok(policy.classifyPath(p, O), p);
  });
});
