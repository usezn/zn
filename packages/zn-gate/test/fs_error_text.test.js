'use strict';

process.env.ZN_STATS = 'off';

// File system errors reach a person in plain words: what is wrong with which path and what to do, never a raw
// EACCES/ENOENT/ENOSPC, and never the name of zn's temporary file. The code shows only with ZN_VERBOSE=1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fsErrorText, humanError, messageWithUnlockHint } = require('../lib/errors');
const { tempDir } = require('./helpers/tmp');

const sys = (code, p) => Object.assign(new Error(code + ': something, open \'' + p + '\''), { code, path: p });
const RAW = /\b(?:EACCES|EPERM|ENOENT|ENOTDIR|EISDIR|ENOSPC|EDQUOT|EROFS|ENAMETOOLONG|ELOOP)\b/;

test('every file system code becomes a sentence that names the path, with no raw code', () => {
  for (const code of ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'EDQUOT', 'EROFS', 'ENAMETOOLONG', 'ELOOP']) {
    const text = fsErrorText(sys(code, '/home/example-user/.zn/vault.json'), null, {});
    assert.ok(text && text.includes('/home/example-user/.zn/vault.json'), code + ': ' + text);
    assert.doesNotMatch(text, RAW, code);
    assert.match(text, /\.$/, code);
  }
  assert.equal(fsErrorText(new Error('other'), null, {}), null);
  assert.equal(fsErrorText(Object.assign(new Error('x'), { code: 'ZN_LOCKED' }), null, {}), null);
});

test('the temporary file of an atomic write is shown as the file it replaces', () => {
  const dir = '/home/example-user/.claude';
  for (const tmp of ['.claude.json.zn-tmp.1234.1793200000000', '.settings.json.1234.0a1b2c3d4e5f6a7b.zn-tmp']) {
    const text = fsErrorText(sys('EACCES', path.join(dir, tmp)), null, {});
    assert.doesNotMatch(text, /zn-tmp/, text);
    assert.ok(text.includes(path.join(dir, tmp.startsWith('.claude') ? 'claude.json' : 'settings.json')), text);
  }
});

test('ZN_VERBOSE shows the code; humanError and the unlock hint use the plain text', () => {
  const e = sys('ENOSPC', '/x/y');
  assert.match(fsErrorText(e, null, { ZN_VERBOSE: '1' }), /^\[ENOSPC\] The disk that holds \/x\/y is full/);
  assert.match(humanError(e, {}), /^The disk that holds \/x\/y is full/);
  assert.match(messageWithUnlockHint(sys('ENOTDIR', '/x/.zn/run')), /is a file where a folder should be/);
});

test('a settings file that cannot be read is not called a parse error', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, (t) => {
  const home = tempDir(t, 'zn-fserr-');
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{}');
  fs.chmodSync(file, 0o000);
  try {
    const cc = require('../lib/agents/claude-code');
    assert.throws(() => cc.install({ scope: 'user', home, env: { HOME: home }, nodePath: process.execPath }), (err) => {
      assert.doesNotMatch(err.message, /cannot parse/);
      assert.doesNotMatch(err.message, RAW);
      assert.ok(err.message.includes(file), err.message);
      return true;
    });
  } finally { fs.chmodSync(file, 0o600); }
});
