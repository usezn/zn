'use strict';
// toolHash of lib/mcp-pins.js: a stable SHA-256 of the whole tool definition.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert');
const pins = require('../lib/mcp-pins');

const TOOL = {
  name: 'lookup',
  description: 'Look up a record by id.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, limit: { type: 'integer' } },
    required: ['id'],
  },
};

test('the result is 64 lowercase hex characters', () => {
  assert.match(pins.toolHash(TOOL), /^[0-9a-f]{64}$/);
  assert.match(pins.toolHash({}), /^[0-9a-f]{64}$/);
});

test('the same tool gives the same hash every time', () => {
  assert.strictEqual(pins.toolHash(TOOL), pins.toolHash(JSON.parse(JSON.stringify(TOOL))));
});

test('key order does not change the hash, at any depth', () => {
  const reordered = {
    inputSchema: {
      required: ['id'],
      properties: { limit: { type: 'integer' }, id: { type: 'string' } },
      type: 'object',
    },
    description: TOOL.description,
    name: TOOL.name,
  };
  assert.strictEqual(pins.toolHash(reordered), pins.toolHash(TOOL));
});

test('a changed description gives another hash', () => {
  assert.notStrictEqual(pins.toolHash({ ...TOOL, description: 'Look up a record by id. ' }), pins.toolHash(TOOL));
});

test('a changed schema gives another hash', () => {
  const more = { ...TOOL, inputSchema: { ...TOOL.inputSchema, properties: { ...TOOL.inputSchema.properties, path: { type: 'string' } } } };
  const retyped = { ...TOOL, inputSchema: { ...TOOL.inputSchema, properties: { id: { type: 'number' }, limit: { type: 'integer' } } } };
  assert.notStrictEqual(pins.toolHash(more), pins.toolHash(TOOL));
  assert.notStrictEqual(pins.toolHash(retyped), pins.toolHash(TOOL));
});

test('array order matters', () => {
  const a = { ...TOOL, inputSchema: { ...TOOL.inputSchema, required: ['id', 'limit'] } };
  const b = { ...TOOL, inputSchema: { ...TOOL.inputSchema, required: ['limit', 'id'] } };
  assert.notStrictEqual(pins.toolHash(a), pins.toolHash(b));
});

test('nested objects and arrays of objects are covered', () => {
  const mk = (v) => ({ name: 't', meta: { list: [{ a: 1, b: { c: [1, 2, { d: v }] } }] } });
  assert.match(pins.toolHash(mk('x')), /^[0-9a-f]{64}$/);
  assert.strictEqual(pins.toolHash(mk('x')), pins.toolHash(mk('x')));
  assert.notStrictEqual(pins.toolHash(mk('x')), pins.toolHash(mk('y')));
});

test('unicode text is hashed and differences in it are seen', () => {
  const mk = (d) => ({ name: 't', description: d });
  const h = pins.toolHash(mk('Größe 日本語 😀'));
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.strictEqual(h, pins.toolHash(mk('Größe 日本語 😀')));
  assert.notStrictEqual(h, pins.toolHash(mk('Grosse 日本語 😀')));
  // composed and decomposed forms are different text
  assert.notStrictEqual(pins.toolHash(mk('é')), pins.toolHash(mk('é')));
});
