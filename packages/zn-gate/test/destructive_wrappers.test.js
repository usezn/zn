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

test('timeout with -s or -k taking a separate value still reaches the destructive command', () => {
  for (const command of ['timeout -s KILL 5 rm -rf /', 'timeout -k 2 5 rm -rf /', 'timeout -k 2 5 nohup rm -rf /']) {
    assert.ok(blocked(command), command);
  }
});

test('every timeout option form is skipped with its value', () => {
  const forms = ['-s KILL 5', '-sKILL 5', '--signal=KILL 5', '--signal KILL 5', '-k 2 5', '-k2 5', '--kill-after=2 5', '--kill-after 2 5',
    '--preserve-status 5', '--foreground 5', '-v 5', '--verbose 5', '-vs KILL 5', '-vk 2 5', '-vsKILL 5', '-s KILL -k 2 5',
    '--foreground --preserve-status -k 2s -s TERM 1.5m', '--sig=KILL 5', '--kill=2 5', '-- 5', '-k 2 -- 5', '5s', '$DURATION'];
  for (const form of forms) {
    for (const command of [`timeout ${form} rm -rf /`, `timeout ${form} nohup rm -rf /home/example-user`, `nohup timeout ${form} sudo rm -rf /`]) {
      assert.ok(blocked(command), command);
    }
  }
});

test('nested timeout and nohup wrappers with options reach the destructive command', () => {
  for (const command of ['timeout -k 2 5 nohup timeout -s KILL 3 rm -rf /', 'timeout -s KILL 9 timeout -k 1 5 rm -rf /home/example-user', 'nice -n 5 timeout -k 2 5 nohup rm -rf /']) {
    assert.ok(blocked(command), command);
  }
});

test('timeout fails closed when its options do not parse', () => {
  // Unknown options, a missing duration and a missing value: the words after them are still checked as the command.
  for (const command of ['timeout --bogus rm -rf /', 'timeout -x 5 rm -rf /', 'timeout rm -rf /', 'timeout -s KILL -k 2 rm -rf /', 'timeout --s=KILL 5 rm -rf /']) {
    assert.ok(blocked(command), command);
  }
  assert.equal(checkCommand('timeout --signal').verdict, 'allow');
});

test('timeout options do not make harmless commands blocked', () => {
  for (const command of ['timeout -s KILL 5 ls /tmp/example-dir', 'timeout -k 2 5 nohup echo hello', 'timeout --kill-after=2 5 rm /tmp/example-file', 'timeout -- 5 ls']) {
    assert.ok(!blocked(command), command);
  }
});
