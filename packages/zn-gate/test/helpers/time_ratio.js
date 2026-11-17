'use strict';
// Growth-ratio checks for the tests that guard against quadratic work (the Node twin of tests/_timing.py in the Python package).
//
// An absolute time limit fails a correct change on a slow or busy CI runner and passes a quadratic scan on a fast machine.
// assertLinear times the same work at a quarter of a size and at the size, after a warm-up, in CPU time of this process (a
// busy shared runner can pause the test in the middle of a correct run; a scan that goes back over earlier text still burns
// the CPU), and requires the larger run to use less than RATIO times the CPU of the smaller one: about 4x for linear work,
// about 16x for quadratic work.
//
// A run that is too short to measure is repeated, never padded: a repeat count is doubled until the small input takes at
// least FLOOR_MS, and the large input is then timed with the same count, so both sides are real measurements of the same
// number of calls and a quadratic function cannot hide behind a fixed floor.
//
// Synchronous work blocks the event loop, so no timer of this thread can stop a regex or parser that hangs. A watchdog in a
// worker thread (its own event loop) watches a deadline kept in shared memory; when the deadline passes it prints the reason
// and kills this process, so the test run fails with a clear message instead of stalling until the job timeout.

const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { cpuNow, cpuMsSince } = require('./time_budget');

const RATIO = 8;
const FLOOR_MS = 20;
const DEADLINE_MS = 60000;
const MAX_REPEATS = 4096;
const EPSILON_MS = 0.001; // only keeps a division from failing when the clock reads zero; it never stands in for a measurement

const WATCHDOG_SOURCE = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const deadline = new BigInt64Array(workerData.deadline);
const label = new Uint8Array(workerData.label);
setInterval(() => {
  const d = Atomics.load(deadline, 0);
  if (d === 0n || BigInt(Date.now()) <= d) return;
  const end = label.indexOf(0);
  const what = Buffer.from(label.slice(0, end < 0 ? label.length : end)).toString('utf8');
  try { fs.writeSync(2, 'assertLinear: did not finish within the deadline' + what + ' (a hang or a runaway scan); killing the test process\\n'); } catch {}
  process.kill(process.pid, 'SIGKILL');
}, 50);
`;

let watchdog = null;

function arm(deadlineMs, where) {
  if (!watchdog) {
    watchdog = { deadline: new SharedArrayBuffer(8), label: new SharedArrayBuffer(512) };
    const worker = new Worker(WATCHDOG_SOURCE, { eval: true, workerData: watchdog });
    worker.unref();
    watchdog.worker = worker;
  }
  const bytes = new Uint8Array(watchdog.label);
  bytes.fill(0);
  bytes.set(Buffer.from(where, 'utf8').subarray(0, 500));
  Atomics.store(new BigInt64Array(watchdog.deadline), 0, BigInt(Date.now() + deadlineMs));
}

function disarm() {
  Atomics.store(new BigInt64Array(watchdog.deadline), 0, 0n);
}

function cpuMs(fn, arg, repeats) {
  const t0 = cpuNow();
  for (let i = 0; i < repeats; i++) fn(arg);
  return cpuMsSince(t0);
}

function measure(fn, build, n, floorMs, ratio) {
  const smallIn = build(Math.max(1, Math.floor(n / 4)));
  const largeIn = build(n);
  fn(build(Math.max(1, Math.floor(n / 16)))); // warm-up: compiled code, caches and lazy requires are paid once, outside the measurement
  fn(smallIn); // and once at the small size itself, so the first timed run is not slower than the later ones
  let repeats = 1;
  let small;
  for (;;) { // the best of two runs is what has to reach the floor, or a lucky fast run would drop below it again
    small = Math.min(cpuMs(fn, smallIn, repeats), cpuMs(fn, smallIn, repeats));
    if (small >= floorMs || repeats >= MAX_REPEATS) break;
    repeats *= 2;
  }
  let large = cpuMs(fn, largeIn, repeats);
  if (large >= ratio * Math.max(small, EPSILON_MS)) large = Math.min(large, cpuMs(fn, largeIn, repeats)); // a passing test costs one large run
  return { small, large, repeats };
}

// fn(build(k)) must take less than RATIO times longer at k === n than at k === n / 4. build(k) makes the input at scale k and
// is not timed; fn(input) is the work that is timed. Each size is the best of two runs (the larger one is run a second time
// only when the first run fails, so a passing test costs one large run). opts: floorMs, ratio, deadlineMs (wall clock, whole call).
function assertLinear(fn, build, n, label = '', opts = {}) {
  const where = label ? ' on ' + label : '';
  arm(opts.deadlineMs === undefined ? DEADLINE_MS : opts.deadlineMs, where);
  const ratio = opts.ratio === undefined ? RATIO : opts.ratio;
  let r;
  try {
    r = measure(fn, build, n, opts.floorMs === undefined ? FLOOR_MS : opts.floorMs, ratio);
  } finally {
    disarm();
  }
  const got = r.large / Math.max(r.small, EPSILON_MS);
  assert.ok(got < ratio, '4x the input took ' + got.toFixed(1) + 'x the CPU time (' + r.small.toFixed(0) + ' ms -> ' + r.large.toFixed(0) + ' ms for ' + r.repeats + ' call(s))' + where);
}

module.exports = { assertLinear };
