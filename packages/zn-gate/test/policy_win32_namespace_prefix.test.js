'use strict';

process.env.ZN_STATS = 'off';

// Windows opens C:\x through `\\?\C:\x`, `\\.\C:\x`, `//?/C:/x`, `\\?\UNC\localhost\C$\x` and `\\localhost\C$\x`. A shell
// reads `\\` as one backslash, so a hook often sees `\?\C:\x`. The prefix is replaced by the drive before the path is
// classified, so an 8.3 short name behind it (`AWS~1\CREDEN~1`) reaches the same resolution as the plain drive path.
// Measured on Windows Server 2022: these spellings open the real file, and before this change `\\?\UNC\localhost\C$\...`
// with a short name was allowed and `type "\\?\C:\...\CREDEN~1"` (backslashes read once by the shell) was allowed too.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const policy = require('../lib/hooks/policy');

function asWindows(fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', real); }
}

const strip = policy._stripNamespacePrefix;
const WANT = 'C:\\Users\\alice\\AWS~1\\CREDEN~1';

test('namespace and device prefixes are replaced by the drive (win32)', () => {
  asWindows(() => {
    const spellings = [
      '\\\\?\\C:\\Users\\alice\\AWS~1\\CREDEN~1',
      '\\\\.\\C:\\Users\\alice\\AWS~1\\CREDEN~1',
      '\\?\\C:\\Users\\alice\\AWS~1\\CREDEN~1', // after the shell read the first backslash pair
      '\\.\\C:\\Users\\alice\\AWS~1\\CREDEN~1',
      '//?/C:\\Users\\alice\\AWS~1\\CREDEN~1',
      '\\\\?\\UNC\\localhost\\C$\\Users\\alice\\AWS~1\\CREDEN~1',
      '\\?\\UNC\\localhost\\C$\\Users\\alice\\AWS~1\\CREDEN~1',
      '//?/UNC/localhost/C$/Users/alice/AWS~1/CREDEN~1',
      '\\\\localhost\\C$\\Users\\alice\\AWS~1\\CREDEN~1',
      '\\localhost\\C$\\Users\\alice\\AWS~1\\CREDEN~1',
      '//127.0.0.1/c$/Users/alice/AWS~1/CREDEN~1',
      '\\\\' + os.hostname() + '\\C$\\Users\\alice\\AWS~1\\CREDEN~1',
    ];
    for (const sp of spellings) {
      const got = strip(sp).replace(/\//g, '\\');
      assert.equal(got.toLowerCase(), WANT.toLowerCase(), sp + ' -> ' + got);
    }
  });
});

test('other paths are left as typed (win32)', () => {
  asWindows(() => {
    for (const sp of [
      'C:\\Users\\alice\\AWS~1\\CREDEN~1',
      'C:/Users/alice/.aws/credentials',
      '\\\\server\\share\\x',
      '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\x',
      '\\other\\C$\\x',
      'relative\\path',
      '',
    ]) assert.equal(strip(sp), sp);
  });
});

test('elsewhere nothing changes', () => {
  if (process.platform === 'win32') return;
  assert.equal(strip('\\\\?\\C:\\x'), '\\\\?\\C:\\x');
  assert.equal(strip('//?/C:/x'), '//?/C:/x');
});

test('a prefixed protected name is still protected (win32, posix layout)', () => {
  asWindows(() => {
    const O = { cwd: 'C:\\Users\\alice\\proj', home: 'C:\\Users\\alice', env: {} };
    for (const p of ['\\\\?\\C:\\Users\\alice\\.aws\\credentials', '\\?\\C:\\Users\\alice\\.aws\\credentials', '//?/C:/Users/alice/.aws/credentials']) {
      assert.ok(policy.classifyPath(p, O), p);
    }
  });
});
