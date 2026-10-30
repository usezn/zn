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
