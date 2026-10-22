'use strict';

// Behaviour of lib/guard.js that the other guard tests left open: a clean
// result passes through the result check, an output too large to scan is
// blocked only when asked, and the options object is validated.
// Values are plain text; nothing here is a real secret.

const test = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../lib/guard');
const { guardTool, GuardBlockError } = guard;
const { MAX_TOOL_RESULT_SCAN_CHARS } = require('../lib/rules');

// One character more than the largest result that is scanned in full.
const TOO_LARGE = 'a'.repeat(MAX_TOOL_RESULT_SCAN_CHARS + 1);

function withBlockTruncatedEnv(value, fn) {
  const saved = process.env.ZN_BLOCK_TRUNCATED;
  if (value === undefined) delete process.env.ZN_BLOCK_TRUNCATED;
  else process.env.ZN_BLOCK_TRUNCATED = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.ZN_BLOCK_TRUNCATED;
    else process.env.ZN_BLOCK_TRUNCATED = saved;
  }
}

test('guardTool with checkResult returns a clean result unchanged', async () => {
  const text = 'The weather in Madrid is sunny, 24 degrees.';
  const sync = guardTool(() => text, { checkResult: true });
  assert.equal(sync(), text);
  const obj = { body: text, items: ['one', 'two'] };
  assert.deepEqual(guardTool(() => obj, { checkResult: true })(), obj);
  assert.equal(await guardTool(async () => text, { checkResult: true })(), text);
  // With onBlock 'return' a block would hand back the fallback instead of the result.
  assert.equal(guardTool(() => text, { checkResult: true, onBlock: 'return', fallback: 'blocked' })(), text);
});

test('an output too large to scan in full is blocked only with blockTruncated', () => {
  withBlockTruncatedEnv(undefined, () => {
    const blocked = guard.scanToolResult(TOO_LARGE, { blockTruncated: true });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.verdict, 'block');
    assert.equal(blocked.rule, 'size:truncated');
    assert.equal(blocked.truncated, true);

    const open = guard.scanToolResult(TOO_LARGE, {});
    assert.equal(open.allowed, true);
    assert.equal(open.truncated, true);
    assert.equal(guard.scanToolResult(TOO_LARGE, { blockTruncated: false }).allowed, true);

    const wrapped = guardTool(() => TOO_LARGE, { checkResult: true, blockTruncated: true, name: 'big' });
    assert.throws(() => wrapped(), (e) => e instanceof GuardBlockError && e.target === 'big:result' && e.assessment.rule === 'size:truncated');
    const asValue = guardTool(() => TOO_LARGE, { checkResult: true, blockTruncated: true, onBlock: 'return' })();
    assert.equal(asValue.allowed, false);
    assert.equal(asValue.rule, 'size:truncated');

    assert.equal(guardTool(() => TOO_LARGE, { checkResult: true })(), TOO_LARGE, 'not blocked without the option');
  });
});

test('ZN_BLOCK_TRUNCATED=1 blocks a truncated result without the option', () => {
  withBlockTruncatedEnv('1', () => {
    const res = guard.scanToolResult(TOO_LARGE, {});
    assert.equal(res.allowed, false);
    assert.equal(res.rule, 'size:truncated');
  });
});

test('guardTool rejects an options value that is not a plain object', () => {
  for (const bad of [null, [], ['onBlock'], 'x', 5, true]) {
    assert.throws(() => guardTool(() => 1, bad), (e) => e instanceof TypeError && /options must be an object/.test(e.message), 'options ' + JSON.stringify(bad));
  }
  assert.doesNotThrow(() => guardTool(() => 1, {}));
});
