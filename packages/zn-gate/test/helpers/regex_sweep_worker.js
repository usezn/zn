'use strict';

// Worker for GuardedTimer (regex_sweep.js): times one literal on its adversarial
// inputs and reports the worst time and the index of that input through shared
// memory, so the main thread can stop waiting and terminate a pattern that hangs.

const { parentPort, workerData } = require('worker_threads');
const { adversarialInputs, timeMatch } = require('./regex_sweep');

const state = new Int32Array(workerData.sab, 0, 2);
const result = new Float64Array(workerData.sab, 8, 1);

parentPort.on('message', ({ body, flags, size, limitMs }) => {
  let worst = 0;
  let index = -1;
  const inputs = Array.from(adversarialInputs(body, size));
  inputs.forEach((input, i) => {
    const quick = timeMatch(body, flags, input, 1);
    const ms = quick > limitMs ? timeMatch(body, flags, input, 2) : quick;
    if (ms > worst) {
      worst = ms;
      index = i;
    }
  });
  result[0] = worst;
  Atomics.store(state, 1, index);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
});
