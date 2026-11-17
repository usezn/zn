'use strict';
// Self-tests of helpers/time_ratio.js: the helper must fail quadratic work, pass linear work and stop a hang.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertLinear } = require('./helpers/time_ratio');

const FLOOR_MS = 10; // a small floor keeps these checks well under a second
const HELPER = path.join(__dirname, 'helpers', 'time_ratio.js');

// Cubic, not quadratic: the growth is 64x for 4x the input, so timer noise and JIT warm-up on a busy machine cannot bring it under the ratio of 8.
function superlinear(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++) for (let j = 0; j < text.length; j++) for (let k = 0; k < text.length; k++) count += (i + j + k) & 1;
  return count;
}

function linear(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++) count += text.charCodeAt(i);
  return count;
}

test('superlinear work fails the growth check', () => {
  // the small run is shorter than the floor: it is repeated, not replaced by the floor, so the growth still shows
  assert.throws(() => assertLinear(superlinear, (n) => 'a'.repeat(n), 150, 'cubic loop', { floorMs: 5 }), /4x the input took/);
});

test('linear work passes the growth check', () => {
  assertLinear(linear, (n) => 'a'.repeat(n), 2000000, 'linear loop', { floorMs: FLOOR_MS });
});

test('a hang is killed at the deadline and reported', () => {
  const script = [
    "const { assertLinear } = require(process.argv[1]);",
    "assertLinear(() => { for (;;) {} }, (n) => 'a'.repeat(n), 100, 'a hanging scan', { deadlineMs: 500 });",
    "process.stdout.write('NOT KILLED');",
  ].join('\n');
  const r = spawnSync(process.execPath, ['-e', script, HELPER], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.error, undefined, 'the child was still running after 20 s: ' + (r.error && r.error.message));
  assert.ok(r.status !== 0, 'the hanging child exited normally');
  assert.ok(!r.stdout.includes('NOT KILLED'));
  assert.match(r.stderr, /did not finish within the deadline on a hanging scan/);
});
