'use strict';

// zn-gate shield: when the wrapped program exits without reading its input, the input piped to the shield must not
// end in an uncaught EPIPE stack trace; the shield exits with the program's own code.
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cli = path.join(__dirname, '..', 'bin', 'cli.js');

function runShield(t, childCode, input) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-shield-epipe-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, 'shield', '--', process.execPath, '-e', `process.exit(${childCode})`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: '' },
    });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.stdout.resume();
    p.stdin.on('error', () => {});
    p.on('close', (code) => resolve({ code, stderr }));
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n';
    // Enough lines that some are written after the program has gone.
    const write = (n) => { if (n > 0 && !p.stdin.destroyed) p.stdin.write(line, () => setImmediate(() => write(n - 1))); else if (!p.stdin.destroyed) p.stdin.end(); };
    if (input) write(2000); else p.stdin.end();
  });
}

test('a wrapped program that exits without reading its input: no EPIPE stack trace, its exit code is kept', async (t) => {
  const r = await runShield(t, 0, true);
  assert.doesNotMatch(r.stderr, /EPIPE|at Socket|Error \[ERR_STREAM_DESTROYED\]|Unhandled 'error' event/, r.stderr);
  assert.equal(r.code, 0);
});

test('the program exit code is passed on when it exits early with an error code', async (t) => {
  const r = await runShield(t, 3, true);
  assert.doesNotMatch(r.stderr, /EPIPE|Unhandled 'error' event/, r.stderr);
  assert.equal(r.code, 3);
});

test('any other error on the server input stops the shield with exit 1 and stops the server', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-shield-stdin-'));
  t.after(() => {
    // Never leave the fake server behind, whatever the result.
    try { process.kill(Number(fs.readFileSync(path.join(home, 'pid'), 'utf8')), 'SIGKILL'); } catch (_) { /* gone */ }
    fs.rmSync(home, { recursive: true, force: true });
  });
  // Preload: after the server starts, make its input report an error that is not EPIPE.
  const preload = path.join(home, 'preload.js');
  fs.writeFileSync(preload, `
    const cp = require('child_process');
    const real = cp.spawn;
    cp.spawn = function (...a) {
      const c = real.apply(this, a);
      if (c.stdin) {
        require('fs').writeFileSync(${JSON.stringify(path.join(home, 'pid'))}, String(c.pid));
        setTimeout(() => c.stdin.emit('error', Object.assign(new Error('simulated input failure'), { code: 'EIO' })), 300);
      }
      return c;
    };
  `);
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, 'shield', '--', process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: '', NODE_OPTIONS: `--require ${preload}` },
    });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.stdout.resume();
    // Without the fix the shield keeps running: give up after 8 s.
    const timer = setTimeout(() => p.kill('SIGKILL'), 8000);
    p.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); });
  });
  assert.equal(r.signal, null, 'the shield kept running: ' + r.stderr);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Could not send input to the server: simulated input failure/);
  const pid = Number(fs.readFileSync(path.join(home, 'pid'), 'utf8'));
  await new Promise((res) => setTimeout(res, 300));
  let alive = true;
  try { process.kill(pid, 0); } catch (_) { alive = false; }
  assert.equal(alive, false, 'the server was left running');
});
