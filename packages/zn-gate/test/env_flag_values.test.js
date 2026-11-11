'use strict';
/*
 * envFlag turns a flag on only for "1". Other non-empty values other than "0" leave it off and
 * say so once on stderr per name and value. Uses a fake environment and a captured stderr.
 */
const test = require('node:test');
const assert = require('node:assert');
const { envFlag, _warned } = require('../lib/env-flag');

const NAME = 'ZN_TEST_FLAG_VALUES';

function withEnv(t, value) {
  const savedEnv = process.env[NAME];
  const savedWrite = process.stderr.write;
  const writes = [];
  const outWrites = [];
  const savedOut = process.stdout.write;
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stdout.write = (chunk) => { outWrites.push(String(chunk)); return true; };
  if (value === undefined) delete process.env[NAME];
  else process.env[NAME] = value;
  for (const k of [..._warned]) if (k.startsWith(NAME + '\0')) _warned.delete(k);
  t.after(() => {
    process.stderr.write = savedWrite;
    process.stdout.write = savedOut;
    if (savedEnv === undefined) delete process.env[NAME];
    else process.env[NAME] = savedEnv;
    for (const k of [..._warned]) if (k.startsWith(NAME + '\0')) _warned.delete(k);
  });
  return { writes, outWrites };
}

test('value 1 turns the flag on without a warning', (t) => {
  const { writes } = withEnv(t, '1');
  assert.strictEqual(envFlag(NAME), true);
  assert.deepStrictEqual(writes, []);
});

test('value 0 is off without a warning', (t) => {
  const { writes } = withEnv(t, '0');
  assert.strictEqual(envFlag(NAME), false);
  assert.deepStrictEqual(writes, []);
});

test('an empty value is off without a warning', (t) => {
  const { writes } = withEnv(t, '');
  assert.strictEqual(envFlag(NAME), false);
  assert.deepStrictEqual(writes, []);
});

test('an unset variable is off without a warning', (t) => {
  const { writes } = withEnv(t, undefined);
  assert.strictEqual(envFlag(NAME), false);
  assert.deepStrictEqual(writes, []);
});

test("'true' is off, warns once on stderr and not a second time", (t) => {
  const { writes, outWrites } = withEnv(t, 'true');
  assert.strictEqual(envFlag(NAME), false);
  assert.strictEqual(writes.length, 1);
  assert.ok(writes[0].includes(NAME));
  assert.ok(writes[0].includes("'true'"));
  assert.ok(writes[0].endsWith('\n'));
  assert.strictEqual(envFlag(NAME), false);
  assert.strictEqual(writes.length, 1);
  assert.deepStrictEqual(outWrites, []);
});

test('a different unexpected value for the same name warns again', (t) => {
  const { writes } = withEnv(t, 'true');
  envFlag(NAME);
  process.env[NAME] = 'yes';
  assert.strictEqual(envFlag(NAME), false);
  assert.strictEqual(writes.length, 2);
  assert.ok(writes[1].includes("'yes'"));
});
