'use strict';

// Work bound of nested shells in the destructive-command check. Each `sh -c` level and each backtick level can be read again
// (whole-line backtick reading, per-segment backtick reading, the backslash reading), and the escaping doubles at each level,
// so the deepest input that is still read, near the size cap, is where the work could grow fastest. These tests check that
// such inputs are read in full (a benign one is allowed, a risky call at the end is found by its own rule), that the work
// stays linear in the input size, and that one level more is refused.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertLinear } = require('./helpers/time_ratio');
const { checkCommand } = require('../lib/destructive');

// One more level of double-quoted `sh -c`: \ " ` $ are escaped, so backslashes double at each level.
const shWrap = (s) => 'sh -c "' + s.replace(/[\\"`$]/g, '\\$&') + '"';
// One more level of backticks: \ and ` are escaped inside the backticks.
const tickWrap = (s) => 'echo `' + s.replace(/[\\`]/g, '\\$&') + '`';
const nest = (wrap, levels) => (s) => { for (let i = 0; i < levels; i += 1) s = wrap(s); return s; };

const PLAIN = 'echo a c\\d; ';          // a backslash in every segment
const TICKED = 'echo a`echo b`c\\d; ';  // and a backtick level of its own

// The deepest shapes that are still read: three levels in all, counting a backtick inside the segment as a level.
const READ = [
  ['sh -c x3', nest(shWrap, 3), PLAIN],
  ['backticks x3', nest(tickWrap, 3), PLAIN],
  ['sh -c, backticks, sh -c', (s) => shWrap(tickWrap(shWrap(s))), PLAIN],
  ['sh -c x2 with backticks inside', nest(shWrap, 2), TICKED],
  ['backticks x2 with backticks inside', nest(tickWrap, 2), TICKED],
];
// One level more than the limit: refused whatever it holds.
const PAST = [
  ['sh -c x4', nest(shWrap, 4), PLAIN],
  ['backticks x4', nest(tickWrap, 4), PLAIN],
  ['sh -c x3 with backticks inside', nest(shWrap, 3), TICKED],
];

// Sized so the largest input stays under the 200 KB command cap for every shape (the escaping grows with depth).
const sizeFor = (wrap, seg) => Math.max(64, Math.floor((150 * 1024) / wrap(seg).length));

test('the deepest nested shells that are read are read in full', () => {
  for (const [label, wrap, seg] of READ) {
    for (const k of [1, 50, sizeFor(wrap, seg)]) {
      assert.equal(checkCommand(wrap(seg.repeat(k) + 'echo done')).verdict, 'allow', label + ' benign k=' + k);
      const risky = checkCommand(wrap(seg.repeat(k) + 'rm -rf /'));
      assert.equal(risky.verdict, 'block', label + ' risky k=' + k);
      assert.notEqual(risky.rule, 'destructive:too_many_commands', label + ' risky k=' + k + ' is found by its own rule');
    }
  }
});

test('one nesting level past the limit is refused, also when it holds nothing risky', () => {
  for (const [label, wrap, seg] of PAST) {
    for (const k of [1, 50]) {
      const r = checkCommand(wrap(seg.repeat(k) + 'echo done'));
      assert.equal(r.verdict, 'block', label + ' k=' + k);
      assert.equal(r.rule, 'destructive:too_many_commands', label + ' k=' + k);
    }
  }
});

test('nested shells near the size cap: the work stays linear in the input size', () => {
  for (const [label, wrap, seg] of READ.concat(PAST)) {
    assertLinear(checkCommand, (k) => wrap(seg.repeat(k) + 'echo done'), sizeFor(wrap, seg), label);
  }
});
