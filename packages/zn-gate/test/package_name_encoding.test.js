'use strict';

process.env.ZN_STATS = 'off';

// A scoped package name has its slash encoded in the registry URL; a name with more slashes is refused, never half-encoded.

const test = require('node:test');
const assert = require('node:assert/strict');

const reg = require('../lib/package-registry');
const { parsePackageSpec } = require('../lib/scan-package');

test('urlFor encodes the slash of a scoped npm name', () => {
  assert.equal(reg.urlFor('npm', '@scope/pkg'), 'https://registry.npmjs.org/@scope%2Fpkg');
});

test('urlFor refuses npm names with repeated slashes', () => {
  for (const name of ['@a/b/c', '@a//b', 'a/b/c/d', '@a/b/c/d/e']) {
    assert.equal(reg.urlFor('npm', name), null, name);
  }
});

test('parsePackageSpec refuses names with repeated slashes', () => {
  for (const spec of ['@a/b/c', '@a//b@1.0.0', 'a/b/c']) {
    assert.throws(() => parsePackageSpec(spec), /not an npm package name/, spec);
  }
});
