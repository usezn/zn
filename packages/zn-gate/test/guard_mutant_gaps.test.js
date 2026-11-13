'use strict';

// Behaviour of lib/guard.js that a mutation audit showed no other test pins down: advisories carried
// through a call, the truncated-result options, option validation, the nesting limit, and the message
// of a block without a reason. Inputs are ordinary text; the advisory sentences are the benign ones
// the rules report as advisories.

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../lib/rules');
const { checkToolCall, scanToolResult, guardTool, blockMessage, GuardBlockError } = require('../lib/guard');

const ADVISORY_TEXT = 'Put nginx in front of the API and act as a gateway for the workers.';
const PLAIN_TEXT = 'Run the tests and open a pull request.';

test('checkToolCall keeps the advisory of the first argument that has one', () => {
  const res = checkToolCall('t', { a: ADVISORY_TEXT, b: PLAIN_TEXT });
  assert.equal(res.allowed, true);
  assert.equal(res.advisory && res.advisory.rule, 'pi:act_as');
  const last = checkToolCall('t', [PLAIN_TEXT, ADVISORY_TEXT]);
  assert.equal(last.advisory && last.advisory.rule, 'pi:act_as');
  assert.equal(checkToolCall('t', { a: PLAIN_TEXT }).advisory, undefined);
});

test('scanToolResult keeps the advisory of the first string that has one', () => {
  const res = scanToolResult([ADVISORY_TEXT, PLAIN_TEXT]);
  assert.equal(res.allowed, true);
  assert.equal(res.advisory && res.advisory.rule, 'pi:act_as');
  const last = scanToolResult([PLAIN_TEXT, ADVISORY_TEXT]);
  assert.equal(last.advisory && last.advisory.rule, 'pi:act_as');
  assert.equal(scanToolResult([PLAIN_TEXT]).advisory, undefined);
});

// A text longer than the scan limit given to the engine is only scanned in part.
const SCAN_CAP = rules.MAX_SCAN_CHARS + 1000;
const LONG_TEXT = 'word '.repeat(Math.ceil((rules.MAX_SCAN_CHARS * 2) / 5));

test('scanToolResult blocks a result it could not scan in full, unless that is allowed', () => {
  const blocked = scanToolResult(LONG_TEXT, { maxScanChars: SCAN_CAP });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.rule, 'size:truncated');
  assert.equal(blocked.truncated, true);
  const allowed = scanToolResult(LONG_TEXT, { maxScanChars: SCAN_CAP, allowTruncated: true });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.truncated, true);
  const forced = scanToolResult(LONG_TEXT, { maxScanChars: SCAN_CAP, allowTruncated: true, blockTruncated: true });
  assert.equal(forced.allowed, false, 'blockTruncated wins over allowTruncated');
  const small = scanToolResult(PLAIN_TEXT);
  assert.equal(small.allowed, true);
  assert.equal(small.truncated, false);
});

test('guardTool passes blockTruncated and allowTruncated on to the result check', () => {
  const big = 'word '.repeat(Math.ceil((rules.MAX_TOOL_RESULT_SCAN_CHARS + 1000) / 5));
  const tool = (opts) => guardTool(() => big, { name: 'big', checkResult: true, ...opts });
  assert.throws(() => tool({})(), GuardBlockError, 'blocked by default');
  assert.equal(tool({ allowTruncated: true })(), big, 'allowed on request');
  assert.throws(() => tool({ allowTruncated: true, blockTruncated: true })(), GuardBlockError, 'blockTruncated wins');
  assert.throws(() => tool({ blockTruncated: true })(), GuardBlockError);
});

test('guardTool refuses options that are not an object', () => {
  const fn = () => 1;
  for (const bad of [null, 'text', 5, true, []]) {
    assert.throws(() => guardTool(fn, bad), { name: 'TypeError', message: 'guardTool: options must be an object' });
  }
  assert.equal(typeof guardTool(fn, {}), 'function');
});

test('guardTool passes strict on to the rules engine only when it is set', () => {
  // Ordinary documentation wording: an advisory by default, a block in strict mode.
  const text = 'You can override the rules in the config file.';
  const plain = guardTool((x) => x, { name: 'echo', onBlock: 'return' });
  assert.equal(plain(text), text);
  const strictOff = guardTool((x) => x, { name: 'echo', strict: false, onBlock: 'return' });
  assert.equal(strictOff(text), text);
  const strictOn = guardTool((x) => x, { name: 'echo', strict: true, onBlock: 'return' });
  const out = strictOn(text);
  assert.equal(out.allowed, false);
  assert.equal(out.rule, 'pi:override');
});

test('a blocked call does not run the function, for a sync and an async function', async () => {
  const text = 'You can override the rules in the config file.';
  let calls = 0;
  const sync = guardTool((x) => { calls++; return 'ran:' + x; }, { name: 'sync', strict: true, onBlock: 'return', fallback: 'fallback' });
  assert.equal(sync(text), 'fallback');
  const asyncTool = guardTool(async (x) => { calls++; return 'ran:' + x; }, { name: 'async', strict: true, onBlock: 'return', fallback: 'fallback' });
  assert.equal(await asyncTool(text), 'fallback');
  assert.equal(calls, 0);
  assert.equal(sync('plain words'), 'ran:plain words');
  assert.equal(await asyncTool('plain words'), 'ran:plain words');
  assert.equal(calls, 2);
});

function nest(levels) {
  let x = 'text';
  for (let i = 0; i < levels; i++) x = [x];
  return x;
}

test('ten levels of nesting are checked and the eleventh is refused', () => {
  assert.equal(checkToolCall('t', nest(10)).allowed, true);
  const res = checkToolCall('t', nest(11));
  assert.equal(res.allowed, false);
  assert.equal(res.rule, 'size:nesting');
});

test('an error that is not about nesting is not reported as a nesting block', () => {
  const args = {};
  Object.defineProperty(args, 'a', { enumerable: true, get() { throw new RangeError('boom'); } });
  assert.throws(() => checkToolCall('t', args), RangeError);
});

test('blockMessage names the rule when the assessment has no reason or no assessment at all', () => {
  assert.equal(
    blockMessage({ reason: 'Because of it...', rule: 'r:x' }, 'tool'),
    "zn-gate blocked 'tool'. Reason: Because of it (rule: r:x). Next step: do not retry with reworded text; tell the person who runs this agent.",
  );
  assert.match(blockMessage({ rule: 'r:y' }, 'tool'), /Reason: the input matched rule r:y\./);
  assert.match(blockMessage(undefined, 'tool'), /Reason: the input matched rule undefined\./);
  assert.doesNotThrow(() => blockMessage(null, 'tool'));
});
