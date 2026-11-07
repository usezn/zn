'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const { znError, loadEngine, loadVault } = require('../lib/deps');

// Make require('<request>') made from lib/deps.js fail with `makeError()`.
function failRequire(t, request, makeError) {
  const original = Module._load;
  Module._load = function (req, parent, ...rest) {
    if (req === request && parent && /deps\.js$/.test(parent.filename || '')) {
      throw makeError();
    }
    return original.call(this, req, parent, ...rest);
  };
  t.after(() => { Module._load = original; });
}

function notFound(message) {
  const err = new Error(message);
  err.code = 'MODULE_NOT_FOUND';
  return err;
}

test('znError sets the code, the message and any extra fields', () => {
  const err = znError('ZN_FAKE', 'fake failure', { detail: 'x' });
  assert.ok(err instanceof Error);
  assert.strictEqual(err.code, 'ZN_FAKE');
  assert.strictEqual(err.message, 'fake failure');
  assert.strictEqual(err.detail, 'x');
});

test('znError works without extra fields', () => {
  const err = znError('ZN_FAKE', 'm');
  assert.deepStrictEqual(Object.keys(err), ['code']);
});

test('loadEngine returns the real engine with tokenize()', () => {
  assert.strictEqual(typeof loadEngine().tokenize, 'function');
});

test('loadEngine reports ZN_UNAVAILABLE when the engine module is missing', (t) => {
  failRequire(t, './scrub/engine', () => notFound("Cannot find module './scrub/engine'"));
  assert.throws(() => loadEngine(), { code: 'ZN_UNAVAILABLE' });
});

test('loadEngine matches the missing path with Windows separators', (t) => {
  failRequire(t, './scrub/engine', () => notFound("Cannot find module 'C:\\x\\scrub\\engine'"));
  assert.throws(() => loadEngine(), { code: 'ZN_UNAVAILABLE' });
});

test('loadEngine rethrows when a different module is missing', (t) => {
  failRequire(t, './scrub/engine', () => notFound("Cannot find module 'zn-fake-module-name'"));
  assert.throws(() => loadEngine(), (err) => err.code === 'MODULE_NOT_FOUND' &&
    /zn-fake-module-name/.test(err.message));
});

test('loadEngine rethrows unrelated load errors unchanged', (t) => {
  failRequire(t, './scrub/engine', () => new SyntaxError('broken'));
  assert.throws(() => loadEngine(), SyntaxError);
});

test('loadVault reports ZN_LOCKED with an unlock hint when the client is missing', async (t) => {
  failRequire(t, './vault/client', () => notFound("Cannot find module './vault/client'"));
  await assert.rejects(loadVault(), (err) => err.code === 'ZN_LOCKED' && /unlock/.test(err.message));
});

test('loadVault rethrows when a different module is missing', async (t) => {
  failRequire(t, './vault/client', () => notFound("Cannot find module 'zn-fake-module-name'"));
  await assert.rejects(loadVault(), { code: 'MODULE_NOT_FOUND' });
});
