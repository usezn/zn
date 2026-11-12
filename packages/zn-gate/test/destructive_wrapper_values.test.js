'use strict';

process.env.ZN_STATS = 'off';

// A wrapper option that takes a value (nice --adjustment 10, stdbuf --output L, flock --wait 5) and a timeout duration
// written the way GNU timeout reads it (inf, 1e3, +5, 0x10) do not hide the command behind them. An option zn does not
// know makes the later words count as possible commands too. The cases are shared with the Python package
// (fixtures/wrapper_value_cases.json). Only the text is checked: nothing is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { checkCommand } = require('../lib/destructive');
const policy = require('../lib/hooks/policy');
const { cpuNow, cpuMsSince } = require('./helpers/time_budget');

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'wrapper_value_cases.json'), 'utf8')).cases;
const rule = (cmd) => { const r = checkCommand(cmd); return r.verdict === 'block' ? r.rule.replace('destructive:', '') : 'allow'; };

test('shared wrapper cases: each command gets the expected rule', () => {
  assert.ok(CASES.length >= 60);
  for (const c of CASES) assert.equal(rule(c.cmd), c.rule, c.cmd);
});

test('timeout skips exactly one duration operand, whatever its spelling', () => {
  const words = (s) => s.split(' ');
  for (const d of ['5', '1.5m', 'inf', 'infinity', '1e3', '+5', '0x10', '.5', 'abc']) {
    assert.equal(policy.skipWrapper(words(`timeout ${d} ls -la`), 0, 'timeout'), 2, d);
    assert.equal(policy.skipWrapper(words(`timeout -s KILL -k 3 ${d} ls`), 0, 'timeout'), 6, d);
  }
  assert.equal(policy.skipWrapper(words('timeout -- inf ls'), 0, 'timeout'), 3);
  assert.equal(policy.skipWrapper(words('timeout'), 0, 'timeout'), 1);
});

test('skipWrapper marks a chain unsure after an unknown option or on a value-like word, and not otherwise', () => {
  const unsure = (s, name) => { const info = {}; policy.skipWrapper(s.split(' '), 0, name, info); return info.unsure === true; };
  assert.equal(unsure('nice --adjustment 10 ls', 'nice'), false);
  assert.equal(unsure('nice -n 10 ls', 'nice'), false);
  assert.equal(unsure('timeout -s KILL inf ls', 'timeout'), false);
  assert.equal(unsure('stdbuf --output=L ls', 'stdbuf'), false);
  assert.equal(unsure('nice --adj 10 ls', 'nice'), true);
  assert.equal(unsure('nice --future 10 ls', 'nice'), true);
  assert.equal(unsure('ionice -t ls', 'ionice'), true);
  assert.equal(unsure('nohup 10 ls', 'nohup'), true);
  assert.equal(unsure('nohup a:b ls', 'nohup'), true);
});

test('the long options are read by the egress wrapper skip too (one table)', () => {
  for (const o of ['--adjustment', '--class', '--classdata', '--pid', '--input', '--output', '--error', '--format', '--wait', '--timeout',
    '--conflict-exit-code', '--userspec', '--groups', '--target']) {
    assert.equal(policy.skipWrapper(['nice', o, 'X', 'ls'], 0, 'nice'), 3, o);
  }
});

test('many later words behind an unsure chain stay within a small time budget', () => {
  const cmd = 'nice --adj 5 echo ' + 'rm sh find dd '.repeat(4000);
  const t0 = cpuNow();
  const r = checkCommand(cmd);
  assert.ok(cpuMsSince(t0) < 1500, 'took ' + cpuMsSince(t0) + ' ms');
  // Past the limit of later words the line is refused rather than guessed at.
  assert.equal(r.verdict, 'block');
});
