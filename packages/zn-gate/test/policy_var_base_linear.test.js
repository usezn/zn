'use strict';

process.env.ZN_STATS = 'off';

// The check for a path to the installed package built while the command runs ("$(npm root -g)/zn-gate/...") takes time
// linear in the command: it used to rescan the rest of the segment from every variable start, which took 8 to 14 s of the
// 15 s hook budget on a 100 KB command.

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

const O = { cwd: '/home/u/proj', home: '/home/u', env: {} };

function ms(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// Best of five runs of each, taken in turn, so a busy shared runner slows both sides alike.
function bestPair(base, target) {
  let b = Infinity, t = Infinity;
  for (let i = 0; i < 5; i++) { b = Math.min(b, ms(base)); t = Math.min(t, ms(target)); }
  return [b, t];
}

const SHAPES = {
  vars: 'rm zn-gate ' + '$a'.repeat(50000),
  subshells: 'rm zn-gate ' + '$(/'.repeat(34000),
  ticks: 'rm zn-gate ' + '`'.repeat(50000),
};

test('a 100 KB command with many variable starts stays fast', () => {
  for (const [name, cmd] of Object.entries(SHAPES)) {
    assert.ok(cmd.length <= 102400, name);
    // The same size without variable starts: the old pattern took 40 to 80 times as long, the linear one about the same
    // (up to 15 times for the subshell shape, which other checks also take longer on). A ratio, so a slow runner does not fail it.
    const plain = 'rm zn-gate ' + 'ab/'.repeat(Math.floor((cmd.length - 11) / 3));
    const [b, t] = bestPair(() => policy.bashDenial(plain, O), () => policy.bashDenial(cmd, O));
    assert.ok(t < Math.max(b, 1) * 30 + 150, name + ' took ' + t + ' ms, a plain command of the same size ' + b + ' ms');
  }
});

test('time grows linearly with the number of variable starts', () => {
  const run = (n) => ms(() => policy.bashDenial('rm zn-gate ' + '$a'.repeat(n), O));
  run(1000);
  const small = Math.max(run(5000), 1);
  const big = run(50000);
  // 10x the starts: linear is about 10x; quadratic would be about 100x.
  assert.ok(big < small * 40 + 200, 'small ' + small + ' ms, big ' + big + ' ms');
});

test('a path built while the command runs is still refused, at any length', () => {
  for (const n of [0, 10, 1023, 1024, 1025, 5000, 40000]) {
    const pad = 'a'.repeat(n);
    for (const cmd of [
      'rm -r "$(npm root -g)' + pad + '/zn-gate/lib"',
      'rm -r $BASE/' + pad + '/node_modules/zn-gate',
      'echo x > ${P}/' + pad + '/zn-gate/lib/hooks/runner.js',
      'rm -r `npm root -g`/' + pad + '/zn-gate',
      'rm -r %APPDATA%\\' + pad + '\\zn-gate\\lib',
    ]) {
      assert.ok(policy.bashDenial(cmd, O), 'allowed: ' + cmd.slice(0, 60) + ' (pad ' + n + ')');
    }
  }
});

test('a long command that does not name the package folder after a variable is still allowed', () => {
  const pad = 'a'.repeat(5000);
  for (const cmd of [
    'rm -r "$(npm root -g)/' + pad + '"',
    'rm -r /zn-gate/' + pad + ' $BASE/x',
    'rm -r /zn-gate ' + pad,
  ]) {
    assert.equal(policy.bashDenial(cmd, O), null, cmd.slice(0, 40));
  }
});

test('segments are judged on their own', () => {
  // The variable and the folder are in different segments, so the old pattern did not match either.
  assert.equal(policy.bashDenial('echo $A; rm /zn-gate/x', O), null);
});
