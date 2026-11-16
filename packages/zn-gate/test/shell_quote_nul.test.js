'use strict';

// A path with a NUL character is refused with the documented text by every
// quoting function; a path without one is quoted as it is. On a system
// without the Windows PowerShell, powershellExe('win32') fails with the
// documented text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sq = require('../lib/shell-quote');

const NUL_MESSAGE = 'zn: a path with a NUL character cannot be passed to a command';

test('shQuote and powershellQuote refuse a NUL with the documented text', () => {
  for (const quote of [sq.shQuote, sq.powershellQuote]) {
    for (const bad of ['a\0b', '\0', '/tmp/example\0', '\0/tmp/example']) {
      assert.throws(() => quote(bad), (e) => e instanceof Error && e.message === NUL_MESSAGE);
    }
  }
});

test('a non-string value with a NUL in its text is refused too', () => {
  const value = { toString: () => 'x\0y' };
  assert.throws(() => sq.shQuote(value), { message: NUL_MESSAGE });
  assert.throws(() => sq.powershellQuote(value), { message: NUL_MESSAGE });
});

test('windowsCommand refuses a NUL in the program, an argument or the encoded form', () => {
  assert.throws(() => sq.windowsCommand('C:/example/zn\0.exe', []), { message: NUL_MESSAGE });
  assert.throws(() => sq.windowsCommand('C:/example/zn.exe', ['ok', 'a\0b']), { message: NUL_MESSAGE });
  assert.throws(() => sq.windowsCommand('C:/example/zn.exe', ['a\0b'], [], { encoded: true }), { message: NUL_MESSAGE });
});

test('a path without a NUL is quoted and the path text is kept', () => {
  assert.equal(sq.shQuote('/tmp/example dir/file'), "'/tmp/example dir/file'");
  assert.equal(sq.shQuote(''), "''");
  assert.equal(sq.powershellQuote('C:/example dir/file'), "'C:/example dir/file'");
  assert.equal(sq.powershellQuote(''), "''");
});

test('a real temporary directory path goes through both quotes unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-nul-'));
  try {
    const plain = dir.replace(/['‘’‚‛\\]/g, '');
    if (plain === dir) {
      assert.equal(sq.shQuote(dir), "'" + dir + "'");
      assert.equal(sq.powershellQuote(dir), "'" + dir + "'");
    }
    assert.throws(() => sq.shQuote(dir + '\0'), { message: NUL_MESSAGE });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('powershellExe names the default install folder for a command written for Windows elsewhere', () => {
  assert.equal(sq.powershellExe('linux'), 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
});

test('powershellExe("win32") without a system PowerShell fails with the documented text', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => sq.powershellExe('win32'), (e) =>
    e instanceof Error &&
    e.message.startsWith('zn: the Windows PowerShell (System32\\WindowsPowerShell\\v1.0\\powershell.exe) was not found under the Windows folder, so no hook was written.') &&
    e.message.endsWith('Next step: run the command again in a normal Windows session; if it keeps failing, report it.'));
});
