'use strict';

// TTY helpers with fake streams and a fake environment.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const tty = require('../lib/broker/tty');

const noAncestor = () => null;

function fakeTty(isTTY = true) {
  const stdin = new PassThrough();
  stdin.isTTY = isTTY;
  stdin.raw = [];
  stdin.setRawMode = (v) => { stdin.raw.push(v); };
  const stderr = new PassThrough();
  let text = '';
  stderr.on('data', (c) => { text += c; });
  return { stdin, stderr, text: () => text };
}

test('agentEnvDetected finds each agent variable, also when empty', () => {
  for (const k of tty.AGENT_ENV_VARS) assert.equal(tty.agentEnvDetected({ [k]: '' }), k);
  assert.equal(tty.agentEnvDetected({ HOME: '/x' }), null);
});

test('agentDetected falls back to the parent process check', () => {
  assert.equal(tty.agentDetected({}, { ancestry: noAncestor }), null);
  assert.equal(tty.agentDetected({}, { ancestry: () => 'fake-agent' }), 'started from fake-agent');
  assert.equal(tty.agentDetected({ ZN_AGENT: '1' }, { ancestry: () => 'fake-agent' }), 'ZN_AGENT');
});

test('requireHuman refuses an agent environment with a policy error', () => {
  const t = fakeTty();
  assert.throws(
    () => tty.requireHuman('zn-gate thing', { stdin: t.stdin, env: { CLAUDECODE: '1' }, ancestry: noAncestor }),
    (e) => e.code === 'ZN_POLICY_DENIED' && /zn-gate thing/.test(e.message) && /CLAUDECODE/.test(e.message),
  );
});

test('requireHuman refuses when stdin is not a TTY', () => {
  const t = fakeTty(false);
  assert.throws(
    () => tty.requireHuman('zn-gate thing', { stdin: t.stdin, env: {}, ancestry: noAncestor }),
    (e) => e.code === 'ZN_POLICY_DENIED' && /interactive terminal/.test(e.message),
  );
});

test('requireHuman passes for a TTY with no agent', () => {
  const t = fakeTty();
  assert.doesNotThrow(() => tty.requireHuman('x', { stdin: t.stdin, env: {}, ancestry: noAncestor }));
});

test('readHidden returns the typed line without echoing it', async () => {
  const t = fakeTty();
  const p = tty.readHidden('Value: ', { stdin: t.stdin, stderr: t.stderr });
  t.stdin.write('fake-value-1\nrest');
  assert.equal(await p, 'fake-value-1');
  assert.match(t.text(), /^Value: /);
  assert.doesNotMatch(t.text(), /fake-value/);
  assert.deepEqual(t.stdin.raw, [true, false]);
});

test('readHidden handles backspace and line kill', async () => {
  const t = fakeTty();
  const p = tty.readHidden('> ', { stdin: t.stdin, stderr: t.stderr });
  t.stdin.write('abcx\u007f\u0015fake\bk\r');
  assert.equal(await p, 'fak' + 'k');
});

test('readHidden rejects on Ctrl-C with a cancel code', async () => {
  const t = fakeTty();
  const p = tty.readHidden('> ', { stdin: t.stdin, stderr: t.stderr });
  t.stdin.write('ab\u0003');
  await assert.rejects(p, { code: 'ZN_CANCELLED' });
  assert.deepEqual(t.stdin.raw, [true, false]);
});

test('readHidden works on a stream without setRawMode', async () => {
  const t = fakeTty();
  delete t.stdin.setRawMode;
  const p = tty.readHidden('> ', { stdin: t.stdin, stderr: t.stderr });
  t.stdin.write('fake\n');
  assert.equal(await p, 'fake');
});

test('confirm accepts y and yes in any case and defaults to no', async () => {
  for (const [input, want] of [['y\n', true], ['YES\r\n', true], [' yes \n', true], ['\n', false], ['n\n', false], ['yep\n', false], ['sure\n', false]]) {
    const t = fakeTty();
    const p = tty.confirm('Go?', { stdin: t.stdin, stderr: t.stderr });
    t.stdin.write(input);
    assert.equal(await p, want, JSON.stringify(input));
    assert.match(t.text(), /Go\? \[y\/N\] $/);
  }
});

test('confirm waits for a full line', async () => {
  const t = fakeTty();
  let done = false;
  const p = tty.confirm('Go?', { stdin: t.stdin, stderr: t.stderr }).then((v) => { done = true; return v; });
  t.stdin.write('y');
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  t.stdin.write('es\n');
  assert.equal(await p, true);
});

test('agentEnvDetected finds each agent variable with a value and names only the first match', () => {
  for (const k of tty.AGENT_ENV_VARS) assert.equal(tty.agentEnvDetected({ HOME: '/x', [k]: '1' }), k);
  assert.equal(tty.agentEnvDetected({ ZN_AGENT: '1', CLAUDECODE: '1' }), 'CLAUDECODE');
});

test('requireHuman refuses for each agent variable and names it', () => {
  for (const k of tty.AGENT_ENV_VARS) {
    const t = fakeTty();
    assert.throws(
      () => tty.requireHuman('zn-gate thing', { stdin: t.stdin, env: { [k]: '' }, ancestry: noAncestor }),
      (e) => e.code === 'ZN_POLICY_DENIED' && e.message.includes(k),
      k,
    );
  }
});

// readClipboard on Linux: fake programs on a temporary PATH must never be run, and the fixed
// absolute tools are replaced by a stub for spawnSync so the result does not depend on the host.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

function loadTtyWithSpawn(spawnStub) {
  const modPath = require.resolve('../lib/broker/tty');
  const original = childProcess.spawnSync;
  childProcess.spawnSync = spawnStub;
  delete require.cache[modPath];
  try {
    return require(modPath);
  } finally {
    childProcess.spawnSync = original;
    delete require.cache[modPath];
  }
}

const linuxOnly = { skip: process.platform !== 'linux' && 'Linux clipboard tools only' };

test('readClipboard throws an unavailable error when no clipboard program exists', linuxOnly, () => {
  const calls = [];
  const fresh = loadTtyWithSpawn((cmd) => { calls.push(cmd); return { error: new Error('ENOENT'), status: null }; });
  assert.throws(() => fresh.readClipboard(), (e) => e.code === 'ZN_UNAVAILABLE');
  assert.deepEqual(calls, ['/usr/bin/wl-paste', '/usr/bin/xclip', '/usr/bin/xsel']);
});

test('readClipboard returns an empty string for an empty clipboard', linuxOnly, () => {
  const fresh = loadTtyWithSpawn(() => ({ status: 0, stdout: '' }));
  assert.equal(fresh.readClipboard(), '');
  const none = loadTtyWithSpawn(() => ({ status: 0, stdout: null }));
  assert.equal(none.readClipboard(), '');
});

test('readClipboard removes one trailing newline only', linuxOnly, () => {
  const read = (out) => loadTtyWithSpawn(() => ({ status: 0, stdout: out })).readClipboard();
  assert.equal(read('fake-value\n'), 'fake-value');
  assert.equal(read('fake-value\r\n'), 'fake-value');
  assert.equal(read('fake-value\n\n'), 'fake-value\n');
  assert.equal(read('fake-value'), 'fake-value');
  assert.equal(read('line one\nline two\n'), 'line one\nline two');
});

test('readClipboard tries the next tool when one fails', linuxOnly, () => {
  const calls = [];
  const fresh = loadTtyWithSpawn((cmd) => {
    calls.push(cmd);
    return cmd === '/usr/bin/xclip' ? { status: 0, stdout: 'fake-value\n' } : { status: 1, stdout: '' };
  });
  assert.equal(fresh.readClipboard(), 'fake-value');
  assert.deepEqual(calls, ['/usr/bin/wl-paste', '/usr/bin/xclip']);
});

test('readClipboard ignores fake clipboard programs on PATH', linuxOnly, () => {
  const hostHasTool = ['/usr/bin/wl-paste', '/usr/bin/xclip', '/usr/bin/xsel'].some((p) => fs.existsSync(p));
  if (hostHasTool) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-clip-'));
  const oldPath = process.env.PATH;
  try {
    for (const name of ['wl-paste', 'xclip', 'xsel']) {
      const f = path.join(dir, name);
      fs.writeFileSync(f, '#!/bin/sh\necho planted-value\n');
      fs.chmodSync(f, 0o755);
    }
    process.env.PATH = dir;
    assert.throws(() => tty.readClipboard(), (e) => e.code === 'ZN_UNAVAILABLE');
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
