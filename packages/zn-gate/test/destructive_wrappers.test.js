'use strict';

// Wrappers that only run their command (nohup, time, nice, setsid, timeout) must not hide a destructive command
// from the destructive-command rules. The targets are strings that are checked, never run.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');

const blocked = (command) => checkCommand(command).verdict === 'block';

test('nohup, time, nice and setsid in front of a destructive command are blocked like the bare form', () => {
  for (const command of ['nohup rm -rf ~', 'time rm -rf /', 'nice -n 10 rm -rf /', 'setsid rm -rf /', 'nohup timeout 5 rm -rf /']) {
    assert.ok(blocked(command), command);
  }
});

test('timeout with a duration in front of a destructive command is blocked like the bare form', () => {
  for (const command of ['timeout 5 rm -rf /', 'timeout 5s nohup rm -rf /', 'timeout --signal=KILL 5 rm -rf /', 'timeout --kill-after=2 5 rm -rf /']) {
    assert.ok(blocked(command), command);
  }
});

test('timeout with -s or -k taking a separate value still reaches the destructive command', {
  todo: 'unwrap() in lib/destructive.js skips the value of -s/-k as if it were the duration, so the command word is missed; the hook allows these too',
}, () => {
  for (const command of ['timeout -s KILL 5 rm -rf /', 'timeout -k 2 5 rm -rf /', 'timeout -k 2 5 nohup rm -rf /']) {
    assert.ok(blocked(command), command);
  }
});
