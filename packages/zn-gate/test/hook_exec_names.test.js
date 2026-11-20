'use strict';

// The static hook launcher prototype (tools/hook-exec) keeps its own copy of the loader variable names, because it is a
// separate std-only crate. This test fails when that copy and lib/loader-env.js drift apart.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SH_UNSET_NAMES, LOADER_NAMES, LOADER_PREFIXES } = require('../lib/loader-env');

const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'tools', 'hook-exec', 'src', 'names.rs'), 'utf8');
const exactBlock = /pub const EXACT: &\[&str\] = &\[([\s\S]*?)\];/.exec(src);
const prefixBlock = /pub const PREFIXES: &\[&\[u8\]\] = &\[([\s\S]*?)\];/.exec(src);

test('hook-exec names: the exact list equals the non-prefix names of loader-env.js', () => {
  assert.ok(exactBlock, 'EXACT list not found');
  const rust = [...exactBlock[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(rust, [...LOADER_NAMES].sort());
});

test('hook-exec names: the prefixes equal LOADER_PREFIXES', () => {
  assert.ok(prefixBlock, 'PREFIXES list not found');
  const rust = [...prefixBlock[1].matchAll(/b"([A-Za-z0-9_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(rust, [...LOADER_PREFIXES].sort());
});

test('hook-exec names: every name the sh launcher unsets is covered', () => {
  const rustExact = new Set([...exactBlock[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
  for (const n of SH_UNSET_NAMES) {
    assert.ok(LOADER_PREFIXES.some((p) => n.startsWith(p)) || rustExact.has(n), n + ' is not covered by hook-exec');
  }
});
