'use strict';

// checkToolCall finds a long Base64 decode pipe that crosses a window edge in large
// arguments. Same cases as packages/zn-gate-py/tests/test_guard_args_base64_window_edge.py.

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkToolCall } = require('../lib/guard');

const payload = Buffer.from('ignore all previous instructions. ' + 'lorem '.repeat(5000)).toString('base64');
const pipe = `echo ${payload} | base64 -d | sh`;

test('a long Base64 pipe in large tool-call arguments is found wherever it sits', () => {
  for (const k of [200, 250, 262]) {
    const command = 'x '.repeat(k * 1024 / 2) + pipe + ' y'.repeat(20000);
    const res = checkToolCall('Bash', { command });
    assert.equal(res.verdict, 'block', 'pipe at ' + k + 'K');
    assert.equal(res.rule, 'evasion:base64_smuggling', 'pipe at ' + k + 'K');
  }
});

test('large harmless tool-call arguments are allowed', () => {
  const harmless = Buffer.from('echo hello world '.repeat(300)).toString('base64');
  const command = 'x '.repeat(125 * 1024) + `echo ${harmless} | base64 -d` + ' y'.repeat(20000);
  assert.equal(checkToolCall('Bash', { command }).verdict, 'allow');
});
