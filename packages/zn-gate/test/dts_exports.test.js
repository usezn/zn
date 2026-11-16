'use strict';
// Every function and constant declared in lib/client.d.ts and lib/evidence.d.ts is exported by the
// matching JavaScript module, with the declared kind (function or non-function value).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const lib = path.resolve(__dirname, '..', 'lib');

function declared(file) {
  const src = fs.readFileSync(path.join(lib, file), 'utf8');
  return {
    functions: [...src.matchAll(/^export (?:declare )?function (\w+)/gm)].map((m) => m[1]),
    constants: [...src.matchAll(/^export (?:declare )?const (\w+)/gm)].map((m) => m[1]),
  };
}

for (const [dts, js] of [['client.d.ts', 'client'], ['evidence.d.ts', 'evidence']]) {
  test(`${dts}: declared functions and constants exist in lib/${js}.js`, () => {
    const mod = require(path.join(lib, js));
    const { functions, constants } = declared(dts);
    assert.ok(functions.length > 0, 'expected declared functions');
    assert.ok(constants.length > 0, 'expected declared constants');
    for (const n of functions) assert.strictEqual(typeof mod[n], 'function', `${js}.js: ${n} is not an exported function`);
    for (const n of constants) {
      assert.ok(n in mod, `${js}.js does not export ${n}`);
      assert.notStrictEqual(typeof mod[n], 'function', `${js}.js: ${n} is declared as a constant`);
      assert.notStrictEqual(mod[n], undefined, `${js}.js: ${n} is undefined`);
    }
  });
}
