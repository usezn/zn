'use strict';
/** A secret used as an object key of a tool output is scrubbed like a value, and no value is lost. Fake values only. */
const assert = require('assert');
const { test, run } = require('./_harness');
const runner = require('../lib/hooks/runner');
const E = require('../lib/scrub/engine');
const { generateAll } = require('./fixtures/fake_secrets');

const SECRETS = generateAll(1337005, { perType: 2 }).secrets.map((s) => s.value);
const [A, B, C] = SECRETS;
const deps = { engine: () => E, vault: async () => null };

async function post(output) {
  const ev = { event: 'post_tool', tool: 'mcp', toolName: 'mcp__srv__tool', input: {}, output, cwd: process.cwd(), sessionId: 's1' };
  return runner.decidePost(ev, deps, 'claude-code');
}
const mapper = () => runner.mapStrings;
const upd = async (o) => (await post(o)).updatedOutput;

test('a secret as a key of the output is redacted', async () => {
  const r = await post({ [A]: 'x' });
  assert.equal(r.decision, 'allow');
  assert.ok(r.updatedOutput, 'output was rewritten');
  assert.ok(!JSON.stringify(r.updatedOutput).includes(A));
  assert.deepEqual(Object.values(r.updatedOutput), ['x']);
});
test('two keys with different secrets keep both values', async () => {
  const out = await upd({ [A]: 'first', [B]: 'second' });
  assert.deepEqual(Object.values(out).sort(), ['first', 'second']);
  assert.ok(!JSON.stringify(out).includes(A) && !JSON.stringify(out).includes(B));
});
test('a masked key next to a clean key with the same text keeps both values', async () => {
  const masked = Object.keys(await upd({ [A]: 1 }))[0];
  assert.notEqual(masked, A);
  const out = await upd({ [masked]: 'clean', [A]: 'secret' });
  assert.equal(out[masked], 'clean');
  assert.deepEqual(Object.values(out).sort(), ['clean', 'secret']);
  assert.ok(!JSON.stringify(out).includes(A));
});
test('nested objects and arrays of objects are covered', async () => {
  const out = await upd({ outer: { [A]: 'n' }, list: [{ [B]: 'a' }, { [C]: 'b', ok: 'c' }] });
  const text = JSON.stringify(out);
  for (const s of [A, B, C]) assert.ok(!text.includes(s));
  assert.deepEqual(Object.values(out.outer), ['n']);
  assert.deepEqual(Object.values(out.list[0]), ['a']);
  assert.deepEqual(Object.values(out.list[1]).sort(), ['b', 'c']);
});
test('key order is kept', async () => {
  const out = await mapper()({ first: 1, [A]: 2, last: 3 }, async (s) => (s === A ? 'masked' : s));
  assert.deepEqual(Object.keys(out), ['first', 'masked', 'last']);
  assert.deepEqual(Object.values(out), [1, 2, 3]);
});
test('colliding mapped keys are numbered, a clean key is never overwritten', async () => {
  const fn = async (s) => (s.startsWith('S') ? 'masked' : s);
  const out = await mapper()({ S1: 1, masked: 2, S2: 3, S3: 4 }, fn);
  assert.deepEqual(Object.keys(out), ['masked #2', 'masked', 'masked #3', 'masked #4']);
  assert.deepEqual(Object.values(out), [1, 2, 3, 4]);
});
test('a __proto__ key stays an ordinary key', async () => {
  const out = await mapper()(JSON.parse('{"__proto__": {"x": "y"}}'), async (s) => s);
  assert.ok(Object.prototype.hasOwnProperty.call(out, '__proto__'));
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
});
test('keys without secrets leave the output untouched', async () => {
  const r = await post({ plain: 'hello world, nothing here', list: [{ a: 'b' }] });
  assert.equal(r.decision, 'allow');
  assert.equal(r.updatedOutput, undefined);
});

if (require.main === module) run();
