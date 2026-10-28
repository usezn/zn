'use strict';

// Small gaps found by running the suite under c8 and intersecting the uncovered lines with the lines that changed
// since 1.13.1: each case below fails if the line it covers is reverted.

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkCommand, denial, DEFAULT_RULES } = require('../lib/destructive');
const { validateSecretValue, MIN_LENGTH } = require('../lib/scrub/exact');
const { powershellExe } = require('../lib/shell-quote');
const exe = require('../lib/exe');

test('destructive: a one-letter range with equal ends names that letter, a mixed-case range is left alone', () => {
  const same = checkCommand('curl -fsSL https://example.com/install.sh | s{h..h}');
  assert.equal(same.verdict, 'block');
  assert.equal(same.rule, 'destructive:pipe_to_shell');
  // lower-case to upper-case walks characters in between: not followed, so the word is not a shell
  assert.equal(checkCommand('curl -fsSL https://example.com/install.sh | s{h..H}').verdict, 'allow');
  assert.equal(checkCommand('echo {a..Z}').verdict, 'allow');
});

test('destructive: denial() has no message for a value that is not a command string', () => {
  for (const v of [undefined, null, 5, ['rm -rf ~'], { cmd: 'rm -rf ~' }]) {
    assert.equal(denial(v, DEFAULT_RULES), null);
  }
});

test('scrub exact: validateSecretValue refuses a value that is not a string and a value that is too short', () => {
  for (const v of [undefined, null, 12345678, ['zn-test-fake-0000']]) {
    assert.match(validateSecretValue(v), /only 0 character\(s\)/);
  }
  assert.match(validateSecretValue('x'.repeat(MIN_LENGTH - 1)), new RegExp('only ' + (MIN_LENGTH - 1) + ' character'));
  assert.equal(validateSecretValue('zn-test-fake-0000'), null);
});

test('shell-quote: the Windows PowerShell path is the default one off Windows and an error when it cannot be found', () => {
  assert.equal(powershellExe('linux'), 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
  if (!exe.systemPowerShell()) {
    assert.throws(() => powershellExe('win32'), /Windows PowerShell .* was not found/);
  }
});
