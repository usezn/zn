'use strict';
// Time limits for the tests that check a command or a text "quickly".
//
// A fixed number of milliseconds fails a correct change on a slow or busy CI runner (a Windows runner
// ran the same check in 15 ms on one run and 27 ms on the next). budget(limit) scales the limit by how
// slow this machine is right now, measured with a fixed loop in the same run: the limit never goes
// below the value given, which is the limit on an idle reference machine, and it is capped, so a check
// that became quadratic (hundreds of times slower) still fails. Only time limits use this; every
// security and behaviour assertion stays exact.

// Milliseconds the loop below takes on the reference machine (measured on a Linux CI-class machine under moderate load, so the limit rarely drops below the value given).
const REFERENCE_MS = 5;
const MAX_SCALE = 20;

function spin() {
  const t0 = process.hrtime.bigint();
  let x = 0;
  for (let i = 0; i < 1e6; i++) x = (x + i * 7) | 0;
  return Number(process.hrtime.bigint() - t0) / 1e6 + (x === 1 ? 1 : 0);
}

function scale() {
  let best = Infinity;
  for (let i = 0; i < 3; i++) best = Math.min(best, spin());
  return Math.min(MAX_SCALE, Math.max(1, best / REFERENCE_MS));
}

// The limit for this run, in milliseconds. Call it where the limit is checked, after the timed work,
// so the measure reflects the machine at that moment.
function budget(limitMs) {
  return Math.round(limitMs * scale());
}

// CPU time of this process (user + system), for the tests that bound a linear-time check. Wall time also
// counts the moments a busy shared runner does not run the process at all, which no code change causes;
// CPU time leaves them out, and a check that became quadratic still burns the CPU, so the limit still
// fails it. It does not count child processes, so a test that waits for one keeps wall time.
function cpuNow() {
  return process.cpuUsage();
}

// Milliseconds of CPU time since the value cpuNow() returned.
function cpuMsSince(start) {
  const c = process.cpuUsage(start);
  return (c.user + c.system) / 1000;
}

module.exports = { budget, scale, spin, cpuNow, cpuMsSince };
