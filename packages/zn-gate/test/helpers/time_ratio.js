'use strict';
// Growth-ratio checks for the tests that guard against quadratic work (the Node twin of tests/_timing.py in the Python package).
//
// An absolute time limit fails a correct change on a slow or busy CI runner and passes a quadratic scan on a fast machine.
// assertLinear times the same work at a quarter of a size and at the size, after a warm-up, in CPU time of this process (a
// busy shared runner can pause the test in the middle of a correct run; a scan that goes back over earlier text still burns
// the CPU), and requires the larger run to use less than RATIO times the CPU of the smaller one: about 4x for linear work,
// about 16x for quadratic work. FLOOR_MS keeps a tiny small-run time from inflating the ratio; HANG_CAP_MS only catches a hang.

const assert = require('node:assert/strict');
const { cpuNow, cpuMsSince } = require('./time_budget');

const RATIO = 8;
const FLOOR_MS = 50;
const HANG_CAP_MS = 60000;

function cpuMs(fn, arg) {
  const t0 = cpuNow();
  fn(arg);
  return cpuMsSince(t0);
}

// fn(build(k)) must take less than RATIO times longer at k === n than at k === n / 4. build(k) makes the input at scale k and
// is not timed; fn(input) is the work that is timed. Each size is the best of two runs (the larger one is run a second time
// only when the first run fails, so a passing test costs one large run).
function assertLinear(fn, build, n, label = '') {
  const smallN = Math.max(1, Math.floor(n / 4));
  fn(build(Math.max(1, Math.floor(n / 16)))); // warm-up: compiled code, caches and lazy requires are paid once, outside the measurement
  const smallIn = build(smallN);
  const largeIn = build(n);
  const small = Math.min(cpuMs(fn, smallIn), cpuMs(fn, smallIn));
  let large = cpuMs(fn, largeIn);
  if (large >= RATIO * Math.max(small, FLOOR_MS)) large = Math.min(large, cpuMs(fn, largeIn));
  const got = large / Math.max(small, FLOOR_MS);
  const where = label ? ' on ' + label : '';
  assert.ok(large < HANG_CAP_MS, 'took ' + large.toFixed(0) + ' ms of CPU' + where);
  assert.ok(got < RATIO, '4x the input took ' + got.toFixed(1) + 'x the CPU time (' + small.toFixed(0) + ' ms -> ' + large.toFixed(0) + ' ms)' + where);
}

module.exports = { assertLinear };
