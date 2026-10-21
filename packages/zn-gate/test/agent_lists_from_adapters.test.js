'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanId, listAdapters } = require('../lib/agents');
const policy = require('../lib/hooks/policy');

test('every adapter id is kept in the zn hooks install hint', () => {
  for (const id of listAdapters()) {
    assert.match(policy.bashDenial('zn hooks install ' + id), new RegExp('hooks install ' + id + '`'), id);
  }
  assert.match(policy.bashDenial('zn hooks install nonsense'), /hooks install <agent>`/);
});

test('agent ids are echoed without line or paragraph separators and lone surrogates', () => {
  const { getAdapter } = require('../lib/agents');
  const msg = (id) => { try { getAdapter(id); } catch (e) { return e.message; } return ''; };
  assert.match(msg('a\u2028b\u2029c\ud800d\udc00e'), /unknown agent "abcde" \(supported:/);
  assert.match(msg('x\u202ey\u0007z'), /unknown agent "xyz"/);
  assert.match(msg('caf\u00e9\ud83d\ude00'), /unknown agent "caf\u00e9\ud83d\ude00"/);
});
