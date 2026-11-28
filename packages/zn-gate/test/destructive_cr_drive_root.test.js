'use strict';

// A Windows command line can end its last word with a carriage return, which cmd reads as the end of the line. The root
// of a drive (or a system folder) followed by one is the same target, in the library and in the hook. Strings only.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');
const { denial } = require('../lib/destructive');

const B = String.fromCharCode(92);
const CR = String.fromCharCode(13);
const O = { cwd: '/home/alice/proj', home: '/home/alice', env: {} };

const BLOCKED = [
  'rd /s /q C:' + B + CR,
  'rd /s /q C:' + CR,
  'rd /s /q C:/' + CR,
  'rmdir /s /q C:' + B + CR + CR,
  'rd /s /q C:' + B + CR + '\n',
  'del /f /s /q C:' + B + '*' + CR,
  'rd /s /q C:' + B + 'Users' + CR,
  'rd /s /q C:' + B + 'Windows' + CR,
  'rm -r' + 'f /' + CR,
];
const ALLOWED = [
  'rd /s /q C:' + B + 'build' + CR,
  'rd /s /q C:' + B + 'Users' + B + 'alice' + B + 'proj' + B + 'out' + CR,
  'rm -r' + 'f /tmp/x' + CR,
  'dir C:' + B + CR,
];

test('a carriage return after a drive root or system folder is still the root', () => {
  for (const c of BLOCKED) {
    assert.ok(denial(c, ['rm_root_home']), 'library: ' + JSON.stringify(c));
    assert.ok(policy.bashDenial(c, O), 'hook: ' + JSON.stringify(c));
  }
});

test('a carriage return after another folder stays allowed', () => {
  for (const c of ALLOWED) {
    assert.equal(denial(c, ['rm_root_home']), null, 'library: ' + JSON.stringify(c));
    assert.equal(policy.bashDenial(c, O), null, 'hook: ' + JSON.stringify(c));
  }
});
