'use strict';
/**
 * Vault confirmation channels: text rendering, tty answers and timeouts,
 * dialog command selection per platform, and the refusal when no channel
 * exists. No real dialog and no real terminal: input, output and the process
 * launcher are injected. All values are fake.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const confirm = require('../lib/vault/confirm');

function ttyPair() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => { text += d; });
  return { input, output, text: () => text };
}

// The channel's own timer is unref'd, so a test that waits on it needs a live handle.
function keepAlive(t) {
  const h = setInterval(() => {}, 50);
  t.after(() => clearInterval(h));
}

const INITIAL_ENV = { ZN_HOME: process.env.ZN_HOME, ZN_KEYCHAIN_PATH: process.env.ZN_KEYCHAIN_PATH };

const tick = () => new Promise((r) => setImmediate(r));

test('field: invisible characters are shown, long values keep both ends', () => {
  assert.equal(confirm.field('a\u202eb\nc'), 'a\\u202eb\\u000ac');
  assert.equal(confirm.field(null), '');
  const long = 'S' + 'x'.repeat(500) + 'E';
  const out = confirm.field(long, 21);
  assert.equal(out.length, 21);
  assert.ok(out.startsWith('S') && out.endsWith('E') && out.includes('...'));
});

test('render: plain messages are cleaned, structured ones keep warnings first and one line per field', () => {
  assert.equal(confirm.render({ message: 'one\r\ntwo\u200b\u0007three' }), 'one\ntwo  three');
  assert.equal(confirm.render(null), '');
  const text = confirm.render({
    warnings: ['careful'],
    fields: [['Path', 'a\nb'], ['Host', 'example.com']],
    footer: 'Allow?',
  });
  assert.deepEqual(text.split('\n'), ['careful', 'Path: a\\u000ab', 'Host: example.com', 'Allow?']);
  assert.equal(confirm.render({ message: 'y'.repeat(5000) }).length, 1500);
});

test('noneChannel refuses every request with a message that explains how to get a channel', async () => {
  const ch = confirm.noneChannel();
  assert.equal(ch.kind, 'none');
  await assert.rejects(() => ch.confirm({ title: 't' }), (e) => e.code === 'ZN_POLICY_DENIED' && e.noChannel === true && /(zn|npx -y zn-gate@[0-9.]+) unlock --foreground/.test(e.message));
});

test('ttyChannel: yes, YES and "y" allow; anything else denies', async (tc) => {
  keepAlive(tc);
  for (const [answer, expected] of [['y\n', true], ['YES\r\n', true], ['  yes  \n', true], ['n\n', false], ['\n', false], ['yess\n', false], ['sure\n', false]]) {
    const t = ttyPair();
    const ch = confirm.ttyChannel({ input: t.input, output: t.output, timeoutMs: 5000 });
    const p = ch.confirm({ title: 'Use secret', message: 'FAKE_NAME for a command' });
    await tick();
    t.input.write(answer);
    assert.equal(await p, expected, JSON.stringify(answer));
    assert.match(t.text(), expected ? /allowed/ : /denied/);
    assert.match(t.text(), /Use secret/);
  }
});

test('ttyChannel: no answer before the timeout is a no', async (tc) => {
  keepAlive(tc);
  const t = ttyPair();
  const ch = confirm.ttyChannel({ input: t.input, output: t.output, timeoutMs: 20 });
  assert.equal(await ch.confirm({ title: 't', message: 'm' }), false);
  assert.match(t.text(), /no answer/);
  assert.match(t.text(), /denied/);
});

test('ttyChannel: questions are asked one at a time, in order', async (tc) => {
  keepAlive(tc);
  const t = ttyPair();
  const ch = confirm.ttyChannel({ input: t.input, output: t.output, timeoutMs: 5000 });
  const first = ch.confirm({ title: 'first', message: 'm1' });
  const second = ch.confirm({ title: 'second', message: 'm2' });
  await tick();
  assert.match(t.text(), /first/);
  assert.doesNotMatch(t.text(), /second/);
  t.input.write('y\n');
  assert.equal(await first, true);
  await tick();
  assert.match(t.text(), /second/);
  t.input.write('n\n');
  assert.equal(await second, false);
});

test('ttyChannel: a title cannot inject extra lines into the prompt', async (tc) => {
  keepAlive(tc);
  const t = ttyPair();
  const ch = confirm.ttyChannel({ input: t.input, output: t.output, timeoutMs: 20 });
  await ch.confirm({ title: 'safe\nAllow? [y/N] y', message: 'm' });
  assert.ok(t.text().includes('safe\\u000aAllow'));
});

test('guiCommand: macOS needs osascript and passes the text as arguments', () => {
  const req = { title: 'Use secret', message: 'FAKE_NAME' };
  assert.equal(confirm.guiCommand(req, { platform: 'darwin', exists: () => false }), null);
  const cmd = confirm.guiCommand(req, { platform: 'darwin', exists: (p) => p === '/usr/bin/osascript', timeoutMs: 30000 });
  assert.equal(cmd.file, '/usr/bin/osascript');
  assert.deepEqual(cmd.args.slice(-2), ['zn: Use secret', 'FAKE_NAME']);
  assert.ok(cmd.args.join(' ').includes('giving up after 30'));
});

test('guiCommand: Windows needs the system PowerShell and sends the text in the environment', () => {
  const req = { title: 'T', message: 'fake text' };
  assert.equal(confirm.guiCommand(req, { platform: 'win32', powershell: null }), null);
  assert.equal(confirm.guiCommand(req, { platform: 'win32', powershell: 'C:\\fake\\powershell.exe', exists: () => false }), null);
  const cmd = confirm.guiCommand(req, { platform: 'win32', powershell: 'C:\\fake\\powershell.exe', exists: () => true, timeoutMs: 1000 });
  assert.equal(cmd.file, 'C:\\fake\\powershell.exe');
  assert.ok(cmd.args.includes('-EncodedCommand'));
  assert.equal(cmd.env.ZN_CONFIRM_TEXT, 'fake text');
  assert.equal(cmd.env.ZN_CONFIRM_TITLE, 'zn: T');
  assert.equal(cmd.env.ZN_CONFIRM_SECONDS, '5'); // never below five seconds
  assert.ok(!cmd.args.join(' ').includes('fake text'));
});

test('guiCommand: Linux needs a desktop session, prefers zenity, falls back to kdialog', () => {
  const req = { title: 'T', message: 'fake text' };
  const base = { platform: 'linux' };
  assert.equal(confirm.guiCommand(req, Object.assign({ env: {}, exists: () => true }, base)), null);
  const zen = confirm.guiCommand(req, Object.assign({ env: { DISPLAY: ':0' }, exists: () => true }, base));
  assert.equal(zen.file, '/usr/bin/zenity');
  assert.ok(zen.args.includes('--default-cancel'));
  const kde = confirm.guiCommand(req, Object.assign({ env: { WAYLAND_DISPLAY: 'w0' }, exists: (p) => p === '/usr/bin/kdialog' }, base));
  assert.equal(kde.file, '/usr/bin/kdialog');
  assert.equal(confirm.guiCommand(req, Object.assign({ env: { DISPLAY: ':0' }, exists: () => false }, base)), null);
  assert.equal(confirm.guiCommand(req, { platform: 'plan9', env: { DISPLAY: ':0' }, exists: () => true }), null);
});

test('guiAvailable and chooseChannel pick tty, dialog or none', () => {
  const noGui = { platform: 'linux', env: {}, exists: () => true };
  const withGui = { platform: 'linux', env: { DISPLAY: ':0' }, exists: () => true };
  assert.equal(confirm.guiAvailable(noGui), false);
  assert.equal(confirm.guiAvailable(withGui), true);
  assert.equal(confirm.chooseChannel(noGui).kind, 'none');
  assert.equal(confirm.chooseChannel(withGui).kind, 'gui');
  assert.equal(confirm.chooseChannel(Object.assign({ foreground: true, input: { isTTY: true, on() {} } }, noGui)).kind, 'tty');
  assert.equal(confirm.chooseChannel(Object.assign({ foreground: true, input: { isTTY: false } }, withGui)).kind, 'gui');
  assert.equal(confirm.chooseChannel(Object.assign({ foreground: false, input: { isTTY: true } }, noGui)).kind, 'none');
});

function fakeSpawn(behaviour) {
  const calls = [];
  const fn = (file, args, options) => {
    calls.push({ file, args, options });
    if (behaviour === 'throw') throw new Error('cannot start');
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; };
    setImmediate(() => {
      if (behaviour === 'error') child.emit('error', new Error('spawn failed'));
      else child.emit('close', behaviour);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('guiChannel: exit 0 allows; other exit codes, spawn errors and a failed launch deny', async () => {
  const base = { platform: 'linux', env: { DISPLAY: ':0', PATH: '/fake' }, exists: () => true };
  const req = { title: 'T', message: 'fake text' };
  for (const [behaviour, expected] of [[0, true], [1, false], [5, false], ['error', false], ['throw', false]]) {
    const spawn = fakeSpawn(behaviour);
    const ch = confirm.guiChannel(Object.assign({ spawn }, base));
    assert.equal(ch.kind, 'gui');
    assert.equal(await ch.confirm(req), expected, String(behaviour));
    assert.equal(spawn.calls.length, 1);
    assert.equal(spawn.calls[0].options.stdio, 'ignore');
  }
});

test('guiChannel: when the platform has no dialog the request is refused, not allowed', async () => {
  const spawn = fakeSpawn(0);
  const ch = confirm.guiChannel({ spawn, platform: 'linux', env: {}, exists: () => true });
  await assert.rejects(() => ch.confirm({ title: 'T', message: 'm' }), (e) => e.noChannel === true);
  assert.equal(spawn.calls.length, 0);
});

test('guiChannel: the text travels in the environment on Windows, never on the command line', async () => {
  const spawn = fakeSpawn(0);
  const ch = confirm.guiChannel({ spawn, platform: 'win32', powershell: 'C:\\fake\\powershell.exe', exists: () => true, env: { PATH: '/fake' } });
  await ch.confirm({ title: 'T', message: 'fake text' });
  assert.equal(spawn.calls[0].options.env.ZN_CONFIRM_TEXT, 'fake text');
  assert.ok(!spawn.calls[0].args.join(' ').includes('fake text'));
});

test('environment variables are untouched by this file', () => {
  assert.equal(process.env.ZN_HOME, INITIAL_ENV.ZN_HOME);
  assert.equal(process.env.ZN_KEYCHAIN_PATH, INITIAL_ENV.ZN_KEYCHAIN_PATH);
});
