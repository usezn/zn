'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const markers = require('../lib/broker/markers');

const allowed = (entries, host) => markers.hostAllowed(entries, host);

test('wildcard matches one or several subdomain levels', () => {
  assert.equal(allowed(['*.example.com'], 'a.example.com'), true);
  assert.equal(allowed(['*.example.com'], 'a.b.example.com'), true);
});

test('wildcard does not match the bare domain or a look-alike', () => {
  assert.equal(allowed(['*.example.com'], 'example.com'), false);
  assert.equal(allowed(['*.example.com'], 'badexample.com'), false);
  assert.equal(allowed(['*.example.com'], 'a.example.com.test'), false);
});

test('capitals are ignored on both sides', () => {
  assert.equal(allowed(['*.EXAMPLE.com'], 'A.Example.COM'), true);
  assert.equal(allowed(['*.example.com'], 'API.EXAMPLE.COM'), true);
  assert.equal(allowed(['*.EXAMPLE.COM'], 'EXAMPLE.com'), false);
});

test('a trailing dot is ignored on both sides', () => {
  assert.equal(allowed(['*.example.com.'], 'a.example.com'), true);
  assert.equal(allowed(['*.example.com'], 'a.example.com.'), true);
  assert.equal(allowed(['*.example.com.'], 'a.b.example.com.'), true);
  assert.equal(allowed(['*.example.com.'], 'example.com.'), false);
});

test('blank entries never match', () => {
  assert.equal(allowed([''], 'example.com'), false);
  assert.equal(allowed(['   '], 'example.com'), false);
  assert.equal(allowed(['.'], 'example.com'), false);
  assert.equal(allowed([null, undefined], 'example.com'), false);
  assert.equal(allowed(['', '*.example.com'], 'a.example.com'), true);
});

test('an empty host never matches', () => {
  assert.equal(allowed(['*.example.com', 'example.com', ''], ''), false);
  assert.equal(allowed(['*.example.com'], '.'), false);
  assert.equal(allowed(['*.example.com'], null), false);
  assert.equal(allowed(['*.example.com'], undefined), false);
});
