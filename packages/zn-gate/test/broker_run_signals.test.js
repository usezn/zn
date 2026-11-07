'use strict';

// SIGINT and SIGTERM sent to `zn run` are forwarded to the child program, and the exit code is the child's
// (or 130 / 143 when the child dies from the signal). The parent is a small driver script that calls
// main() from lib/broker/run.js, so the signals reach a real process and not the test runner.
// POSIX only: Windows has no SIGINT/SIGTERM delivery to a child process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { tempDir } = require('./helpers/tmp');

const RUN_JS = path.resolve(__dirname, '..', 'lib', 'broker', 'run.js');

// Driver: zn run -- node <child> <marker> <ready>. Its exit code is the exit code of zn run.
const DRIVER = [
  "'use strict';",
  'const { main } = require(' + JSON.stringify(RUN_JS) + ');',
  'main(process.argv.slice(2));',
].join('\n');

// Child that traps both signals: writes the signal name to the marker and exits with 5.
const TRAPPING_CHILD = [
  "'use strict';",
  "const fs = require('fs');",
  'const [marker, ready] = process.argv.slice(2);',
  'const trap = (name) => () => { fs.writeFileSync(marker, name); process.exit(5); };',
  "process.on('SIGTERM', trap('SIGTERM'));",
  "process.on('SIGINT', trap('SIGINT'));",
  "fs.writeFileSync(ready, 'ready');",
  'setInterval(() => {}, 1000);',
].join('\n');

// Child with no handler: the signal kills it, so zn run reports 143 (SIGTERM) or 130 (SIGINT).
const PLAIN_CHILD = [
  "'use strict';",
  "const fs = require('fs');",
  'const [, ready] = process.argv.slice(2);',
  "fs.writeFileSync(ready, 'ready');",
  'setInterval(() => {}, 1000);',
].join('\n');

function waitFor(file, ms = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (fs.existsSync(file)) return resolve();
      if (Date.now() - started > ms) return reject(new Error('timed out waiting for ' + file));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function runDriver(t, childSource, signal) {
  const dir = tempDir(t, 'zn-b2190-sig-');
  const driver = path.join(dir, 'driver.js');
  const child = path.join(dir, 'child.js');
  const marker = path.join(dir, 'got-signal.txt');
  const ready = path.join(dir, 'ready.txt');
  fs.writeFileSync(driver, DRIVER);
  fs.writeFileSync(child, childSource);
  const proc = spawn(process.execPath, [driver, '--', process.execPath, child, marker, ready], {
    env: { ...process.env, HOME: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code, sig) => resolve({ code, sig })));
  await waitFor(ready);
  proc.kill(signal);
  const { code, sig } = await exited;
  assert.equal(sig, null, 'zn run itself exits with a code, not by the signal: ' + stderr);
  return { code, marker: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null, stderr };
}

const skipOnWin = { skip: process.platform === 'win32' && 'POSIX signals' };

test('SIGTERM to zn run reaches the child, and zn run exits with the child code', skipOnWin, async (t) => {
  const r = await runDriver(t, TRAPPING_CHILD, 'SIGTERM');
  assert.equal(r.marker, 'SIGTERM');
  assert.equal(r.code, 5);
});

test('SIGINT to zn run reaches the child, and zn run exits with the child code', skipOnWin, async (t) => {
  const r = await runDriver(t, TRAPPING_CHILD, 'SIGINT');
  assert.equal(r.marker, 'SIGINT');
  assert.equal(r.code, 5);
});

test('a child without a handler killed by SIGTERM gives exit 143', skipOnWin, async (t) => {
  const r = await runDriver(t, PLAIN_CHILD, 'SIGTERM');
  assert.equal(r.marker, null);
  assert.equal(r.code, 143);
});

test('a child without a handler killed by SIGINT gives exit 130', skipOnWin, async (t) => {
  const r = await runDriver(t, PLAIN_CHILD, 'SIGINT');
  assert.equal(r.marker, null);
  assert.equal(r.code, 130);
});
