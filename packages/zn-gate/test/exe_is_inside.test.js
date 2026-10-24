'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isInside } = require('../lib/exe');

const parent = path.resolve(path.join('example', 'work', 'project'));

test('isInside: a child directly under the parent is inside', () => {
  assert.equal(isInside(path.join(parent, 'src'), parent), true);
});

test('isInside: a deeper descendant is inside', () => {
  assert.equal(isInside(path.join(parent, 'src', 'lib', 'a.js'), parent), true);
});

test('isInside: the parent itself is inside', () => {
  assert.equal(isInside(parent, parent), true);
});

test('isInside: a sibling whose name starts with the parent name is not inside', () => {
  assert.equal(isInside(parent + '-old', parent), false);
  assert.equal(isInside(path.join(parent + '-old', 'src'), parent), false);
});

test('isInside: a path that climbs out with .. is not inside', () => {
  assert.equal(isInside(path.resolve(parent, '..', 'other'), parent), false);
  assert.equal(isInside(path.join(parent, '..', 'other'), parent), false);
});

test('isInside: the parent of the parent is not inside', () => {
  assert.equal(isInside(path.dirname(parent), parent), false);
});
