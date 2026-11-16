'use strict';
// evidence --port and --tail: whole numbers only (usage error, exit 2); a busy port is one plain line (exit 1).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-evui-'));
const ENV = Object.assign({}, process.env, {
  NO_COLOR: '1', ZN_STATS: 'off', ZN_LOCAL_ONLY: 'true', HOME, USERPROFILE: HOME,
});

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: '', env: ENV, timeout: 20000 });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function assertPlain(r) {
  assert.doesNotMatch(r.stderr, /\n\s+at |node:internal|Error:/);
  assert.strictEqual(r.stderr.trim().split('\n').length, 1);
  assert.strictEqual(r.stdout, '');
}

test('evidence --ui --port with a value that is not a number exits 2 with one line', () => {
  for (const v of ['abc', '12x', '-5', '1.5', '', '0']) {
    const r = run(['evidence', '--ui', '--port', v]);
    assert.strictEqual(r.status, 2, 'value "' + v + '"');
    assert.match(r.stderr, /--port needs a whole number from 1 to 65535/);
    assertPlain(r);
  }
});

test('evidence --ui --port out of range exits 2', () => {
  for (const v of ['99999', '65536']) {
    const r = run(['evidence', '--ui', '--port', v]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /--port needs a whole number from 1 to 65535, not "/);
    assertPlain(r);
  }
  const eq = run(['evidence', '--ui', '--port=99999']);
  assert.strictEqual(eq.status, 2);
  assertPlain(eq);
});

test('evidence --ui --port without a value exits 2', () => {
  const r = run(['evidence', '--ui', '--port']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /--port needs a whole number/);
});

test('evidence --ui on a busy port prints one plain line and exits 1', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const port = blocker.address().port;
  try {
    for (const args of [['--port', String(port)], ['--port=' + port]]) {
      const r = run(['evidence', '--ui', ...args]);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, new RegExp('port ' + port + ' is in use; choose another with --port'));
      assert.doesNotMatch(r.stderr, /\n\s+at |node:internal|Error:/);
      assert.strictEqual(r.stderr.trim().split('\n').length, 1);
    }
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('evidence --tail must be a positive whole number', () => {
  for (const v of ['abc', '0', '-3', '2.5', '', '5x']) {
    const r = run(['evidence', '--tail', v]);
    assert.strictEqual(r.status, 2, 'value "' + v + '"');
    assert.match(r.stderr, /--tail needs a positive whole number/);
    assertPlain(r);
  }
  const noValue = run(['evidence', '--tail']);
  assert.strictEqual(noValue.status, 2);
});

test('evidence --tail 5 and --tail=5 still work', () => {
  for (const args of [['--tail', '5'], ['--tail=5']]) {
    const r = run(['evidence', ...args]);
    assert.strictEqual(r.status, 0, r.stderr);
  }
});

test('evidence --ui with a valid --port starts the dashboard on loopback', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, 'evidence', '--ui', '--port=' + port], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const out = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('dashboard did not start: ' + buf)), 15000);
      child.stdout.on('data', (d) => {
        buf += d;
        if (buf.includes('Press Ctrl+C')) { clearTimeout(timer); resolve(buf); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error('exited ' + code + ': ' + buf)); });
    });
    assert.match(out, new RegExp('http://127\\.0\\.0\\.1:' + port));
  } finally {
    child.kill();
    await new Promise((resolve) => { if (child.exitCode !== null || child.signalCode) resolve(); else child.once('exit', resolve); });
  }
});

test.after(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
