'use strict';
process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

// Windows builds a short name from a hash once five names collide (`SE1A2B~1.JSO`). It does not start with the
// long name, so under a protected folder every short name must count as protected.
function asWindows(fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', real); }
}
const REAL_WIN = process.platform === 'win32';
const L = (p) => (REAL_WIN ? 'C:' + p.split('/').join(String.fromCharCode(92)) : p);
const P = { cwd: L('/Users/user/proj'), home: L('/Users/user'), env: {} };

const PROTECTED = [
  '/Users/user/.claude/SE1A2B~1.JSO',
  '/Users/user/.claude/se1a2b~1.jso',
  '/Users/user/CLAUDE~1/SE1A2B~1.JSO',
  '/Users/user/CLAUDE~1/A1B2C3~1',
  '/Users/user/.ssh/X9Y8Z7~1',
  '/Users/user/.aws/QW12ER~1',
  '/Users/user/AWS~1/QW12ER~1',
].map(L);
const ALLOWED = [
  '/Users/user/proj/ABCDEF~1.TXT',
  '/Users/user/proj/src/ABCDEF~1/ZZ99YY~1.TXT',
  '/Users/user/Documents/SE1A2B~1.JSO',
  '/Users/user/.cache/SE1A2B~1.JSO',
].map(L);

test('a hash-form short name under a protected folder is protected (win32)', () => {
  asWindows(() => {
    const missed = PROTECTED.filter((p) => !policy.classifyPath(p, P));
    assert.deepEqual(missed, []);
    for (const p of PROTECTED.filter((x) => /claude/i.test(x))) assert.ok(policy.bashDenial('echo x>"' + p + '"', P), p);
    for (const p of PROTECTED.filter((x) => !/claude/i.test(x))) assert.ok(policy.bashDenial('type ' + p, P), p);
  });
});

test('a short-name file outside protected folders stays allowed (win32)', () => {
  asWindows(() => {
    for (const p of ALLOWED) assert.equal(policy.classifyPath(p, P), null, p);
  });
});

test('the same names on posix are plain names', { skip: REAL_WIN && 'posix only' }, () => {
  assert.equal(policy.classifyPath('/home/user/proj/ABCDEF~1.TXT', { cwd: '/home/user/proj', home: '/home/user', env: {} }), null);
});
