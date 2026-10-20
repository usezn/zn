'use strict';

// Terminal helpers of the broker (lib/broker/tty.js): hidden input, yes/no confirmation and the
// clipboard reader. Streams are fakes; the clipboard runner is stubbed, so no real tool ever runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { PassThrough } = require('stream');

const messages = require('../lib/messages');
const tty = require('../lib/broker/tty');

function fakeStdin(raw = false) {
  const s = new PassThrough();
  s.isTTY = true;
  s.isRaw = raw;
  s.rawCalls = [];
  s.setRawMode = (m) => { s.rawCalls.push(m); s.isRaw = m; };
  return s;
}
function fakeErr() {
  const s = new PassThrough();
  s.text = '';
  s.on('data', (c) => { s.text += c; });
  return s;
}
const tick = () => new Promise((r) => setImmediate(r));

test('readHidden: returns the typed line, never echoes it, restores raw mode', async () => {
  const stdin = fakeStdin(false);
  const stderr = fakeErr();
  const p = tty.readHidden('Value: ', { stdin, stderr });
  stdin.write('sk-fake-1234');
  await tick();
  stdin.write('\r');
  assert.equal(await p, 'sk-fake-1234');
  await tick();
  assert.ok(stderr.text.startsWith('Value: '));
  assert.ok(!stderr.text.includes('sk-fake'), 'the value is never written back');
  assert.deepEqual(stdin.rawCalls, [true, false]);
  assert.equal(stdin.listenerCount('data'), 0);
});

test('readHidden: newline ends input, later characters are ignored, raw mode returns to its previous value', async () => {
  const stdin = fakeStdin(true);
  const p = tty.readHidden('> ', { stdin, stderr: fakeErr() });
  stdin.write('abc\nignored');
  assert.equal(await p, 'abc');
  assert.deepEqual(stdin.rawCalls, [true, true]);
});

test('readHidden: backspace (DEL and BS) removes one character, Ctrl-U clears the line', async () => {
  let stdin = fakeStdin();
  let p = tty.readHidden('> ', { stdin, stderr: fakeErr() });
  stdin.write('abcd\u007f\u007fX\b\r');
  assert.equal(await p, 'ab');

  stdin = fakeStdin();
  p = tty.readHidden('> ', { stdin, stderr: fakeErr() });
  stdin.write('wrong\u0015right\r');
  assert.equal(await p, 'right');

  stdin = fakeStdin();
  p = tty.readHidden('> ', { stdin, stderr: fakeErr() });
  stdin.write('\u007f\u007f\r');
  assert.equal(await p, '', 'backspace on an empty line is harmless');
});

test('readHidden: Ctrl-C rejects with ZN_CANCELLED and the documented message', async () => {
  const stdin = fakeStdin();
  const p = tty.readHidden('> ', { stdin, stderr: fakeErr() });
  stdin.write('part\u0003more');
  await assert.rejects(p, (e) => e.code === 'ZN_CANCELLED' && e.message === messages.PROMPT_CANCELLED);
  assert.deepEqual(stdin.rawCalls, [true, false]);
  assert.equal(stdin.listenerCount('data'), 0);
});

test('readHidden: input split across chunks is joined; stdin without setRawMode still works', async () => {
  const stdin = new PassThrough();
  const p = tty.readHidden('> ', { stdin, stderr: fakeErr() });
  stdin.write('ab');
  await tick();
  stdin.write('cd\r');
  assert.equal(await p, 'abcd');
});

test('confirm: true only for y / yes (any case, surrounding spaces); everything else is no', async () => {
  const cases = [
    ['y\n', true], ['Y\r', true], ['yes\n', true], ['YES\n', true], ['  yes  \n', true],
    ['\n', false], ['n\n', false], ['no\n', false], ['yy\n', false], ['yeah\n', false],
    ['sure\n', false], ['y es\n', false], ['\u0000garbage\n', false],
  ];
  for (const [input, expected] of cases) {
    const stdin = fakeStdin();
    const stderr = fakeErr();
    const p = tty.confirm('Continue?', { stdin, stderr });
    stdin.write(input);
    assert.equal(await p, expected, JSON.stringify(input));
    assert.ok(stderr.text.startsWith('Continue? [y/N] '));
    assert.equal(stdin.listenerCount('data'), 0);
  }
});

test('confirm: waits for the newline, joining chunks, and only reads the first line', async () => {
  const stdin = fakeStdin();
  const p = tty.confirm('Go?', { stdin, stderr: fakeErr() });
  stdin.write('ye');
  await tick();
  stdin.write('s');
  await tick();
  stdin.write('\nnope\n');
  assert.equal(await p, true);
});

test('requireHuman: refuses a non-TTY stdin and an agent environment', () => {
  const noAgent = { ancestry: () => null };
  assert.doesNotThrow(() => tty.requireHuman('x', { stdin: { isTTY: true }, env: {}, ...noAgent }));
  assert.throws(() => tty.requireHuman('x', { stdin: { isTTY: false }, env: {}, ...noAgent }), (e) => e.code === 'ZN_POLICY_DENIED');
  assert.throws(() => tty.requireHuman('x', { stdin: { isTTY: true }, env: { CLAUDECODE: '' }, ...noAgent }), (e) => e.code === 'ZN_POLICY_DENIED');
  assert.throws(() => tty.requireHuman('x', { stdin: { isTTY: true }, env: {}, ancestry: () => 'fake-agent' }), (e) => e.code === 'ZN_POLICY_DENIED' && /fake-agent/.test(e.message));
});

// ---- readClipboard: the runner (child_process.spawnSync) is replaced before the module loads ----

function loadWithRunner(platform, runner, psPath) {
  const modPath = require.resolve('../lib/broker/tty');
  const exeMod = require('../lib/exe');
  const realSpawn = childProcess.spawnSync;
  const realExe = exeMod.systemPowerShell;
  const platDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  childProcess.spawnSync = runner;
  exeMod.systemPowerShell = () => psPath;
  Object.defineProperty(process, 'platform', { value: platform });
  delete require.cache[modPath];
  const mod = require(modPath);
  return {
    mod,
    restore() {
      childProcess.spawnSync = realSpawn;
      exeMod.systemPowerShell = realExe;
      Object.defineProperty(process, 'platform', platDesc);
      delete require.cache[modPath];
    },
  };
}

test('readClipboard (linux): absolute tool paths only; a fake tool planted on PATH is never run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-clip-'));
  const marker = path.join(dir, 'ran');
  for (const name of ['wl-paste', 'xclip', 'xsel', 'pbpaste']) {
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\ntouch ' + marker + '\necho planted\n', { mode: 0o755 });
  }
  const savedPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + savedPath;
  const calls = [];
  const h = loadWithRunner('linux', (cmd) => {
    calls.push(cmd);
    return cmd === '/usr/bin/xclip' ? { status: 0, stdout: 'fake-secret\n' } : { error: new Error('ENOENT'), status: null };
  });
  try {
    assert.equal(h.mod.readClipboard(), 'fake-secret');
    assert.deepEqual(calls, ['/usr/bin/wl-paste', '/usr/bin/xclip']);
    assert.ok(calls.every((c) => c.startsWith('/') && !c.startsWith(dir)));
    assert.ok(!fs.existsSync(marker), 'the planted tool was not executed');
  } finally {
    h.restore();
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readClipboard (linux): strips one trailing newline; non-zero exit moves to the next tool', () => {
  const h = loadWithRunner('linux', (cmd) => (cmd === '/usr/bin/wl-paste' ? { status: 1, stdout: 'x' } : { status: 0, stdout: 'a\r\n\n' }));
  try {
    assert.equal(h.mod.readClipboard(), 'a\r\n');
  } finally { h.restore(); }
});

test('readClipboard (linux): fails closed with ZN_UNAVAILABLE naming the tools tried', () => {
  const h = loadWithRunner('linux', () => ({ error: new Error('ENOENT'), status: null }));
  try {
    assert.throws(() => h.mod.readClipboard(), (e) => e.code === 'ZN_UNAVAILABLE'
      && e.message === messages.clipboardUnreadable(['/usr/bin/wl-paste', '/usr/bin/xclip', '/usr/bin/xsel']));
  } finally { h.restore(); }
});

test('readClipboard (darwin): uses /usr/bin/pbpaste', () => {
  const calls = [];
  const h = loadWithRunner('darwin', (cmd, args) => { calls.push([cmd, args]); return { status: 0, stdout: 'mac-fake' }; });
  try {
    assert.equal(h.mod.readClipboard(), 'mac-fake');
    assert.deepEqual(calls, [['/usr/bin/pbpaste', []]]);
  } finally { h.restore(); }
});

test('readClipboard (win32): runs the resolved system PowerShell, and fails closed without it', () => {
  const calls = [];
  let h = loadWithRunner('win32', (cmd, args) => { calls.push([cmd, args]); return { status: 0, stdout: 'win-fake\r\n' }; }, 'C:\\fake\\powershell.exe');
  try {
    assert.equal(h.mod.readClipboard(), 'win-fake');
    assert.equal(calls[0][0], 'C:\\fake\\powershell.exe');
    assert.deepEqual(calls[0][1], ['-NoProfile', '-Command', 'Get-Clipboard -Raw']);
  } finally { h.restore(); }

  h = loadWithRunner('win32', () => { throw new Error('must not run'); }, null);
  try {
    assert.throws(() => h.mod.readClipboard(), (e) => e.code === 'ZN_UNAVAILABLE' && e.message === messages.CLIPBOARD_NO_POWERSHELL);
  } finally { h.restore(); }
});
