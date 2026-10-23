'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toolsForVersion } = require('../lib/mcp-protocol');

const TOOLS = [
  { name: 'one', description: 'First', inputSchema: { type: 'object' }, annotations: { title: 'One Title', readOnlyHint: true } },
  { name: 'two', description: 'Second', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
  { name: 'three', description: 'Third', inputSchema: { type: 'object' } },
];

test('toolsForVersion 2024-11-05 drops annotations from every tool', () => {
  const out = toolsForVersion(TOOLS, '2024-11-05');
  assert.equal(out.length, 3);
  for (const t of out) assert.equal('annotations' in t, false);
  assert.deepEqual(out.map((t) => t.name), ['one', 'two', 'three']);
  assert.equal(out[0].description, 'First');
  assert.ok(TOOLS[0].annotations, 'input is not modified');
});

test('toolsForVersion 2025-03-26 returns the tools unchanged', () => {
  const out = toolsForVersion(TOOLS, '2025-03-26');
  assert.deepEqual(out, TOOLS);
  for (const t of out) assert.equal('title' in t, false);
});

for (const version of ['2025-06-18', '2025-11-25', undefined]) {
  test(`toolsForVersion ${version || 'undefined (latest)'} adds title from annotations.title`, () => {
    const out = toolsForVersion(TOOLS, version);
    assert.deepEqual(out[0], { ...TOOLS[0], title: 'One Title' });
    assert.deepEqual(Object.keys(out[0]).slice(0, 2), ['name', 'title']);
    assert.deepEqual(out[0].annotations, TOOLS[0].annotations);
    assert.equal(out[1], TOOLS[1]);
    assert.equal(out[2], TOOLS[2]);
    assert.equal('title' in out[1], false);
    assert.equal('title' in out[2], false);
  });
}
