'use strict';

process.env.ZN_STATS = 'off';

// An event that repeats a key at the top level can be read two ways: JSON.parse keeps the last value, a reader
// of the text the first. Such an event is refused whatever its size. Keys repeated only inside nested objects
// (tool arguments, tool output) are ordinary and unaffected.

const test = require('node:test');
const assert = require('node:assert/strict');

const runner = require('../lib/hooks/runner');
const { AGENTS } = require('./helpers/post_events');

async function run(name, text) {
  const err = [];
  const out = [];
  const write = process.stderr.write;
  const wout = process.stdout.write;
  const code = process.exitCode;
  let exit;
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  process.stdout.write = (chunk, cb) => { out.push(String(chunk)); if (typeof cb === 'function') cb(); return true; };
  try {
    await runner.main([name], async () => text);
    exit = process.exitCode;
  } finally {
    process.stderr.write = write;
    process.stdout.write = wout;
    process.exitCode = code;
  }
  return { err: err.join(''), out: out.join(''), exit };
}

const KEY = 'AKIAQQQQQQQQQQQQQQQQ'; // fictitious

test('claude-code: a normal-size event repeating the hook event key is refused', async () => {
  const text = JSON.stringify(AGENTS['claude-code'].event('a=' + KEY));
  // the first occurrence says pre-tool, the last (the one JSON.parse keeps) says post-tool
  const dup = text.replace(/^\{/, '{"hook_event_name":"PreToolUse",');
  assert.equal(JSON.parse(dup).hook_event_name, 'PostToolUse');
  const r = await run('claude-code', dup);
  assert.equal(r.exit, 2);
  assert.match(r.err, /repeats a key/);
  assert.ok(!r.out.includes('updatedToolOutput'));
});

test('claude-code: the same repeat written with an escaped key is refused too', async () => {
  const text = JSON.stringify(AGENTS['claude-code'].event('x'));
  const dup = text.replace(/^\{/, '{"hook_event_nam\u0065":"PreToolUse",');
  const r = await run('claude-code', dup);
  assert.equal(r.exit, 2);
  assert.match(r.err, /repeats a key/);
});

for (const name of ['claude-code', 'codex', 'copilot', 'opencode', 'cursor']) {
  test(name + ': a normal-size event repeating a top-level key is refused', async () => {
    const text = JSON.stringify(AGENTS[name].event('hello'));
    const dup = text.replace(/^\{(")([^"]+)"/, (m, q, k) => '{"' + k + '":"first","' + k + '"');
    const r = await run(name, dup);
    assert.equal(r.exit, 2);
    assert.match(r.err, /repeats a key/);
  });

  test(name + ': keys repeated only in nested objects are unaffected', async () => {
    const text = JSON.stringify(AGENTS[name].event('hello'));
    const nested = text.replace('hello', () => 'hello');
    const ev = JSON.parse(nested);
    ev.extra = '{"k":1}';
    let body = JSON.stringify(ev).replace('"extra":"{\\"k\\":1}"', '"extra":{"k":1,"k":2}');
    const r = await run(name, body);
    assert.doesNotMatch(r.err, /repeats a key/);
  });
}

test('a Stop event that repeats a key is not blocked', async () => {
  const text = '{"hook_event_name":"Stop","session_id":"s","session_id":"t","last_assistant_message":"hi"}';
  const r = await run('claude-code', text);
  assert.notEqual(r.exit, 2);
  assert.match(r.err, /Stop event/);
});
