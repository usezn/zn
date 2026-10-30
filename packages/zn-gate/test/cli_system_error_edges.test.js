'use strict';

process.env.ZN_STATS = 'off';

// System-error edge cases in plain words: a Windows path that is too long, an agent folder that cannot be read,
// a settings file that is a link to nothing. All with a temporary HOME, never a real agent folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fsErrorText } = require('../lib/errors');
const { scanEnvironments } = require('../lib/init');
const { dispatch } = require('../lib/broker/cli');
const { tempDir } = require('./helpers/tmp');

const posixOnly = { skip: process.platform === 'win32' };

test('a path of 260 characters or more on Windows is called too long, not "does not exist"', () => {
  const long = 'C:\\Users\\example-user\\' + 'a'.repeat(250) + '\\settings.json';
  for (const code of ['ENOENT', 'EINVAL', 'ENAMETOOLONG']) {
    const text = fsErrorText(Object.assign(new Error(code), { code, path: long }), null, {}, 'win32');
    assert.match(text, /folder path .* is too long/, code);
    assert.match(text, /Move the folder to a shorter path/, code);
    assert.doesNotMatch(text, /\b(ENOENT|EINVAL|ENAMETOOLONG)\b/, code);
  }
  // A short missing path stays "does not exist", and other systems keep their own codes.
  assert.match(fsErrorText(Object.assign(new Error('x'), { code: 'ENOENT', path: 'C:\\x\\y.json' }), null, {}, 'win32'), /does not exist/);
  assert.match(fsErrorText(Object.assign(new Error('x'), { code: 'ENOENT', path: long }), null, {}, 'linux'), /does not exist/);
});

test('an agent folder that cannot be read is not reported as "not installed"', posixOnly, (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('root can read everything');
  const home = tempDir(t, 'zn-edge-home-');
  const dir = path.join(home, 'agent');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, '{}');
  fs.chmodSync(dir, 0o000);
  const missing = path.join(home, 'nothing-here', 'mcp.json');
  let cannot, absent;
  try {
    [cannot, absent] = scanEnvironments([
    { name: 'Example', filePath: file, adapter: 'standard' },
    { name: 'Other', filePath: missing, adapter: 'standard' },
  ]);
  } finally { fs.chmodSync(dir, 0o700); }
  assert.equal(cannot.exists, false);
  assert.match(cannot.unreadable, /not allowed to read or change .*mcp\.json.*permissions/);
  assert.equal(absent.unreadable, '');
});

test('hooks install refuses a settings file that is a link to nothing, and keeps the link', posixOnly, async (t) => {
  const home = tempDir(t, 'zn-edge-home-');
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude);
  const link = path.join(claude, 'settings.json');
  fs.symlinkSync(path.join(home, 'dotfiles', 'settings.json'), link);
  let stdout = '';
  let stderr = '';
  const code = await dispatch('hooks', ['install', 'claude-code'], {
    stdout: { write: (x) => { stdout += x; } }, stderr: { write: (x) => { stderr += x; } },
    env: { HOME: home }, home, cwd: home, human: true,
  });
  assert.notEqual(code, 0);
  assert.doesNotMatch(stdout, /Installed/);
  assert.match(stderr, /link to a file that does not exist, so zn did not change anything/);
  assert.match(stderr, /hooks install claude-code/);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is still a link');
});
