'use strict';

process.env.ZN_STATS = 'off';

// sentenceOf and skeleton from lib/package-check.js, called directly. Local only: no network, no files.

const test = require('node:test');
const assert = require('node:assert/strict');

const pc = require('../lib/package-check');

/* -------------------------------- skeleton -------------------------------- */

test('skeleton: rn becomes m, vv becomes w', () => {
  assert.equal(pc.skeleton('rnodule'), 'module');
  assert.equal(pc.skeleton('vvebpack'), 'webpack');
});

test('skeleton: 0 becomes o, and 1 and i both become l', () => {
  assert.equal(pc.skeleton('l0dash'), 'lodash');
  assert.equal(pc.skeleton('1odash'), 'lodash');
  assert.equal(pc.skeleton('mix'), 'mlx');
  assert.equal(pc.skeleton('i1l'), 'lll');
});

test('skeleton: a name without confusable characters is unchanged', () => {
  assert.equal(pc.skeleton('express'), 'express');
  assert.equal(pc.skeleton(''), '');
});

test('skeleton: an m written as rn and an m match after the change', () => {
  assert.equal(pc.skeleton('exarnple'), pc.skeleton('example'));
  assert.equal(pc.skeleton('vv0r1d'), pc.skeleton('world'));
});

test('skeleton: upper case letters are not folded', () => {
  assert.equal(pc.skeleton('RN0I'), 'RNoI');
});

/* ------------------------------- sentenceOf ------------------------------- */

test('sentenceOf: not_found names the registry for each ecosystem', () => {
  assert.equal(
    pc.sentenceOf({ eco: 'npm', name: 'fake-pkg-example', kind: 'not_found' }),
    'npm package `fake-pkg-example` was not found on the npm registry, so the name may have been made up',
  );
  assert.equal(
    pc.sentenceOf({ eco: 'pypi', name: 'fake-pkg-example', kind: 'not_found' }),
    'Python package `fake-pkg-example` was not found on PyPI, so the name may have been made up',
  );
});

test('sentenceOf: new_package gives the age in days', () => {
  const f = (days) => pc.sentenceOf({ eco: 'npm', name: 'fresh-example', kind: 'new_package', days });
  assert.equal(f(0), 'npm package `fresh-example` was first published less than a day ago');
  assert.equal(f(1), 'npm package `fresh-example` was first published 1 day ago');
  assert.equal(f(5), 'npm package `fresh-example` was first published 5 days ago');
});

test('sentenceOf: scope finding points at the well-known scope', () => {
  assert.equal(
    pc.sentenceOf({ eco: 'npm', name: '@typos/react', kind: 'scope', suggestion: '@types/react' }),
    'npm package `@typos/react` uses a scope that looks like the well-known one in `@types/react` (did you mean `@types/react`?)',
  );
});

test('sentenceOf: look-alike kinds share one sentence', () => {
  for (const kind of ['separators', 'confusable', 'one_edit']) {
    assert.equal(
      pc.sentenceOf({ eco: 'pypi', name: 'reqeusts', kind, suggestion: 'requests' }),
      'Python package `reqeusts` looks like the well-known `requests` (did you mean `requests`?)',
    );
  }
});

test('sentenceOf: matches what messageOf puts in the question', () => {
  const f = { eco: 'npm', name: 'l0dash', kind: 'confusable', suggestion: 'lodash' };
  assert.ok(pc.messageOf([f]).includes(pc.sentenceOf(f)));
});
