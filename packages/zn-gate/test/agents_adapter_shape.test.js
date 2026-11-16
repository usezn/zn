'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getAdapter, listAdapters } = require('../lib/agents');

const DIR = path.join(__dirname, '..', 'lib', 'agents');
const REQUIRED_FUNCTIONS = ['detect', 'install', 'uninstall', 'normalize', 'respond'];

// Every file in lib/agents that exports a string id is an adapter; the others are helpers.
function adapterFiles() {
  const out = [];
  for (const file of fs.readdirSync(DIR)) {
    if (!file.endsWith('.js') || file === 'index.js') continue;
    const mod = require(path.join(DIR, file));
    if (mod && typeof mod.id === 'string') out.push({ file, mod });
  }
  return out;
}

test('adapter files are found', () => {
  assert.ok(adapterFiles().length >= 7);
});

test('every adapter exports the same required functions', () => {
  for (const { file, mod } of adapterFiles()) {
    for (const name of REQUIRED_FUNCTIONS) {
      assert.equal(typeof mod[name], 'function', file + ' exports ' + name);
    }
  }
});

test('every adapter has a non-empty, unique agent id', () => {
  const ids = adapterFiles().map(({ mod }) => mod.id);
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]*$/);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique: ' + ids.join(', '));
});

test('the registry lists every adapter file exactly once', () => {
  const fromFiles = adapterFiles().map(({ mod }) => mod.id).sort();
  const listed = listAdapters();
  assert.equal(new Set(listed).size, listed.length);
  assert.deepEqual([...listed].sort(), fromFiles);
});

test('each registry entry resolves to the adapter with that id', () => {
  for (const id of listAdapters()) {
    assert.equal(getAdapter(id).id, id);
  }
});
