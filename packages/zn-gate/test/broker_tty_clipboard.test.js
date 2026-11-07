'use strict';

// readClipboard with a fake spawnSync and a fake platform: no real clipboard tool is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

const ttyPath = require.resolve('../lib/broker/tty');
const realSpawnSync = childProcess.spawnSync;
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

// Loads a fresh copy of the module that sees the fake spawnSync and platform.
function load(platform, fake) {
  const calls = [];
  childProcess.spawnSync = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return fake(cmd, args); };
  Object.defineProperty(process, 'platform', { value: platform });
  delete require.cache[ttyPath];
  return { tty: require(ttyPath), calls };
}

test.afterEach(() => {
  childProcess.spawnSync = realSpawnSync;
  Object.defineProperty(process, 'platform', realPlatform);
  delete require.cache[ttyPath];
});

test('readClipboard on macOS uses pbpaste and strips one trailing newline', () => {
  const { tty, calls } = load('darwin', () => ({ status: 0, stdout: 'fake-value\n' }));
  assert.equal(tty.readClipboard(), 'fake-value');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, '/usr/bin/pbpaste');
  assert.equal(calls[0].opts.encoding, 'utf8');
});

test('readClipboard strips only one trailing line break, also CRLF', () => {
  assert.equal(load('darwin', () => ({ status: 0, stdout: 'a\r\n' })).tty.readClipboard(), 'a');
  assert.equal(load('darwin', () => ({ status: 0, stdout: 'a\n\n' })).tty.readClipboard(), 'a\n');
});

test('readClipboard returns an empty string for empty or missing output', () => {
  assert.equal(load('darwin', () => ({ status: 0, stdout: '' })).tty.readClipboard(), '');
  assert.equal(load('darwin', () => ({ status: 0 })).tty.readClipboard(), '');
});

test('readClipboard on Linux tries wl-paste, xclip and xsel in order with absolute paths', () => {
  const { tty, calls } = load('linux', (cmd) => (cmd === '/usr/bin/xsel' ? { status: 0, stdout: 'from-xsel' } : { status: 1, stdout: '' }));
  assert.equal(tty.readClipboard(), 'from-xsel');
  assert.deepEqual(calls.map((c) => c.cmd), ['/usr/bin/wl-paste', '/usr/bin/xclip', '/usr/bin/xsel']);
  assert.deepEqual(calls[0].args, ['--no-newline']);
  assert.deepEqual(calls[1].args, ['-selection', 'clipboard', '-o']);
  assert.deepEqual(calls[2].args, ['--clipboard', '--output']);
});

test('readClipboard on Linux skips a tool that failed to start', () => {
  const { tty, calls } = load('linux', (cmd) => (cmd === '/usr/bin/wl-paste' ? { error: new Error('ENOENT'), status: null } : { status: 0, stdout: 'x\n' }));
  assert.equal(tty.readClipboard(), 'x');
  assert.equal(calls.length, 2);
});

test('readClipboard on Linux stops at the first tool that works', () => {
  const { tty, calls } = load('linux', () => ({ status: 0, stdout: 'first' }));
  assert.equal(tty.readClipboard(), 'first');
  assert.equal(calls.length, 1);
});

test('readClipboard throws ZN_UNAVAILABLE naming the tools it tried', () => {
  const { tty } = load('linux', () => ({ status: 1, stdout: '' }));
  assert.throws(() => tty.readClipboard(), (err) => {
    assert.equal(err.code, 'ZN_UNAVAILABLE');
    for (const t of ['/usr/bin/wl-paste', '/usr/bin/xclip', '/usr/bin/xsel']) assert.ok(err.message.includes(t));
    return true;
  });
});

test('readClipboard on macOS throws when pbpaste exits non-zero', () => {
  const { tty } = load('darwin', () => ({ status: 2, stdout: 'ignored' }));
  assert.throws(() => tty.readClipboard(), (err) => err.code === 'ZN_UNAVAILABLE' && err.message.includes('/usr/bin/pbpaste'));
});
