'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkToolCall, scanToolResult, extractStrings } = require('../lib/guard');

const CAP_MS = 120000;

test('a result with 200000 small objects returns a verdict', { timeout: CAP_MS }, () => {
  const items = [];
  for (let i = 0; i < 200000; i++) items.push({ k: 'v' + i });
  const res = scanToolResult({ items });
  assert.equal(typeof res.allowed, 'boolean');
  assert.equal(res.allowed, true);
});

test('300000 references to the same object return a verdict', { timeout: CAP_MS }, () => {
  const shared = { k: 'value' };
  const res = scanToolResult(new Array(300000).fill(shared));
  assert.equal(res.allowed, true);
});

test('checkToolCall with 300000 strings returns a verdict', { timeout: CAP_MS }, () => {
  const args = { list: [] };
  for (let i = 0; i < 300000; i++) args.list.push('s' + i);
  const res = checkToolCall('t', args);
  assert.equal(res.allowed, true);
});

test('a dangerous string among very many is still blocked', { timeout: CAP_MS }, () => {
  const list = new Array(200000).fill('ok');
  list.push('~/.ssh/id_rsa');
  assert.equal(checkToolCall('t', { list }).allowed, false);
  assert.equal(extractStrings(list).length, 200001);
});
