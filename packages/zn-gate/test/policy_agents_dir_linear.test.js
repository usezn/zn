'use strict';

process.env.ZN_STATS = 'off';

// The check for a write into the .agents hook folder takes time linear in the command: a command of many long words,
// each with many `.agents/` starts, used to cost a full rescan of the word at every start.

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

const O = { cwd: '/home/u/proj', home: '/home/u', env: {} };

function ms(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// Under the 100 KiB scan cap, with words just below the 4096-character limit of the per-word check.
const SHAPES = {
  repeated: () => ('.agents/' + 'a/').repeat(400),
  prefixed: () => '/.agents/b'.repeat(400),
  chain: () => '.agents/' + 'a/'.repeat(1990) + 'x',
};

test('many long words with many .agents starts stay fast', () => {
  for (const [name, mk] of Object.entries(SHAPES)) {
    const cmd = 'cp x ' + Array(24).fill(mk()).join(' ');
    assert.ok(cmd.length < 100 * 1024, name);
    let r;
    const t = ms(() => { r = policy.bashDenial(cmd, O); });
    assert.ok(t < 300, name + ' took ' + t + ' ms');
    assert.equal(r, null, name);
  }
});

test('time grows linearly with the number of words', () => {
  const word = SHAPES.repeated();
  const run = (n) => ms(() => policy.bashDenial('cp x ' + Array(n).fill(word).join(' '), O));
  run(2);
  const small = Math.max(run(6), 1);
  const big = run(24);
  // 4x the words: linear is about 4x; the bound leaves room for noise on a shared runner.
  assert.ok(big < small * 40 + 200, 'small ' + small + ' ms, big ' + big + ' ms');
});

test('the folder is still found in a long command', () => {
  const filler = Array(20).fill('a/'.repeat(1000)).join(' ');
  for (const tail of ['.agents/hooks.json', '.agents/x/../y', '.agents/*', '.agents/', '.agents', 'a/.agents/b/hooks.json']) {
    assert.ok(policy.bashDenial('cp x ' + filler + ' ' + tail, O), tail);
    assert.ok(policy.bashDenial('cp x ' + ('.agents/a/'.repeat(300)) + tail, O), tail);
  }
  assert.equal(policy.bashDenial('cp x ' + filler + ' .agents/skills/a.md', O), null);
});
