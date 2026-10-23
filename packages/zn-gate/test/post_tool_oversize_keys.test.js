'use strict';

process.env.ZN_STATS = 'off';

// An event over the stdin limit (32 MiB) is never parsed, so what it is has to be read from its top-level keys.
// Those keys are found wherever they are in the text that was read, in any order, and a key or a marker inside
// the tool arguments or the tool output never counts. A post-tool event is then answered with the fixed notice
// in place of the output (exit 2 on a post-tool event lets the original output reach the model); an event
// whose name comes after the cap is answered like a post-tool event too. The big inputs are built here.

const test = require('node:test');
const assert = require('node:assert/strict');

const runner = require('../lib/hooks/runner');

const CAP = runner.POST_STDIN_CAP;
const NOTICE = /output withheld because it is too large to check/;
const q = JSON.stringify;

// Built once: a string just over the limit.
let bigFiller;
const big = () => bigFiller || (bigFiller = 'A'.repeat(CAP + 1024 * 1024));
const mid = 'B'.repeat(200 * 1024); // after the first 64 KiB, far below the limit

/** An event as text, with its keys in the given order. */
function build(order, values) {
  return '{' + order.map((k) => q(k) + ':' + values[k]).join(',') + '}';
}

async function runMain(agent, text) {
  const out = [];
  const err = [];
  const wout = process.stdout.write;
  const werr = process.stderr.write;
  const code = process.exitCode;
  process.exitCode = undefined;
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  let exit;
  try {
    await runner.main([agent], async () => text);
    exit = process.exitCode;
  } finally {
    process.stdout.write = wout;
    process.stderr.write = werr;
    process.exitCode = code;
  }
  return { out: out.join(''), err: err.join(''), exit };
}

// What each agent that has a replacement for the output must answer with.
function assertWithheld(agent, r) {
  assert.notEqual(r.exit, 2, 'exit 2 would let the original output through');
  assert.ok(r.out.length > 0 && r.out.length < 3000, 'a small answer: ' + r.out.length);
  assert.ok(!r.out.includes('AAAA') && !r.out.includes('BBBB'), 'none of the output in the answer');
  const a = JSON.parse(r.out);
  assert.match(r.out, NOTICE);
  if (agent === 'claude-code') {
    assert.equal(a.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(String(a.hookSpecificOutput.updatedToolOutput), NOTICE);
  } else if (agent === 'codex') {
    assert.equal(a.decision, 'block');
    assert.match(a.reason, NOTICE);
  }
}

function assertRefused(r) {
  assert.equal(r.exit, 2);
  assert.match(r.err, /too large/);
  assert.ok(!r.out.includes('withheld'));
}

const EVENT = { 'claude-code': ['PreToolUse', 'PostToolUse'], codex: ['PreToolUse', 'PostToolUse'] };

for (const agent of ['claude-code', 'codex']) {
  const [PRE, POST] = EVENT[agent];
  const v = (extra) => ({ session_id: q('s'), cwd: q('/'), tool_name: q('Bash'), tool_input: q({ command: 'ls' }), tool_use_id: q('t1'), ...extra });

  // [key, value] pairs in the order of the event text.
  const postEvents = {
    'name first, the big output after it': () => [['hook_event_name', q(POST)], ['session_id', q('s')], ['cwd', q('/')], ['tool_name', q('Bash')], ['tool_input', q({ command: 'ls' })], ['tool_response', q(big())], ['tool_use_id', q('t1')]],
    'name after 200 KiB of output, the big text after it': () => [['session_id', q('s')], ['cwd', q('/')], ['tool_name', q('Bash')], ['tool_response', q(mid)], ['hook_event_name', q(POST)], ['tool_input', q({ command: big() })], ['tool_use_id', q('t1')]],
    'name in the middle of two 200 KiB blocks': () => [['session_id', q('s')], ['tool_input', q({ command: mid })], ['tool_response', q(mid)], ['cwd', q('/')], ['hook_event_name', q(POST)], ['tool_name', q('Bash')], ['tool_use_id', q(big())]],
    'name after the output, tool name last': () => [['tool_response', q(mid)], ['hook_event_name', q(POST)], ['session_id', q(big())], ['tool_name', q('Bash')]],
  };
  for (const [label, make] of Object.entries(postEvents)) {
    test(agent + ': an oversized post-tool event is withheld, ' + label, async () => {
      const text = '{' + make().map(([k, x]) => q(k) + ':' + x).join(',') + '}';
      assert.ok(text.length > CAP, 'the event is over the limit');
      assert.ok(text.indexOf('"hook_event_name"') < CAP, 'the name is inside the characters that are read');
      const t = Date.now();
      const r = await runMain(agent, text);
      assert.ok(Date.now() - t < 5000, 'answered in ' + (Date.now() - t) + ' ms');
      assertWithheld(agent, r);
    });
  }

  test(agent + ': an oversized event whose name comes after the limit is answered like a post-tool event', async () => {
    const order = ['session_id', 'cwd', 'tool_name', 'tool_response', 'hook_event_name'];
    const text = build(order, v({ hook_event_name: q(POST), tool_response: q(big()) }));
    assert.ok(text.indexOf('hook_event_name') > CAP);
    assertWithheld(agent, await runMain(agent, text));
  });

  test(agent + ': a nested hook_event_name and one inside a string do not fool the parser (post-tool event)', async () => {
    const decoys = q({
      hook_event_name: PRE,
      note: '"hook_event_name":"' + PRE + '"',
      list: [{ hook_event_name: PRE }, '{"hook_event_name":"' + PRE + '"}'],
      data: mid,
    });
    const order = ['session_id', 'tool_name', 'tool_input', 'tool_response', 'hook_event_name', 'cwd'];
    const text = build(order, v({ tool_input: q({ hook_event_name: PRE, command: 'ls' }), tool_response: decoys, hook_event_name: q(POST), cwd: q(big()) }));
    assertWithheld(agent, await runMain(agent, text));
  });

  test(agent + ': a nested post-tool name inside the arguments of an oversized pre-tool event is refused', async () => {
    const decoys = q({ hook_event_name: POST, note: '"hook_event_name":"' + POST + '"', tool_response: 'x', data: mid });
    const order = ['session_id', 'tool_name', 'tool_input', 'hook_event_name', 'cwd'];
    const text = build(order, v({ tool_input: decoys, hook_event_name: q(PRE), cwd: q(big()) }));
    assertRefused(await runMain(agent, text));
  });

  test(agent + ': an oversized pre-tool event with the name after 200 KiB is refused', async () => {
    const order = ['session_id', 'cwd', 'tool_input', 'hook_event_name', 'tool_name'];
    const text = build(order, v({ tool_input: q({ command: mid }), hook_event_name: q(PRE), tool_name: q(big()) }));
    assertRefused(await runMain(agent, text));
  });

  test(agent + ': an oversized UserPromptSubmit event is refused', async () => {
    const order = ['session_id', 'cwd', 'prompt', 'hook_event_name'];
    const text = build(order, { session_id: q('s'), cwd: q('/'), prompt: q(mid + big()), hook_event_name: q('UserPromptSubmit') });
    // The name is after the cap: this is answered like a post-tool event, never passed through.
    const r = await runMain(agent, text);
    assert.ok(r.out.length > 0 || r.exit === 2, 'not passed through');
    const early = await runMain(agent, build(['hook_event_name', 'session_id', 'prompt'], { hook_event_name: q('UserPromptSubmit'), session_id: q('s'), prompt: q(big()) }));
    assertRefused(early);
  });

  test(agent + ': an oversized Stop event passes with a warning, never exit 2', async () => {
    const r = await runMain(agent, build(['session_id', 'hook_event_name', 'last_assistant_message'], { session_id: q('s'), hook_event_name: q('Stop'), last_assistant_message: q(big()) }));
    assert.notEqual(r.exit, 2);
    assert.equal(r.out, '');
    assert.match(r.err, /Stop event/);
  });
}

test('cursor: an oversized post-tool event is withheld whatever the order of its keys', async () => {
  const text = build(['conversation_id', 'tool_name', 'tool_output', 'hook_event_name', 'cwd'],
    { conversation_id: q('c'), tool_name: q('MCP:tool'), tool_output: q(mid), hook_event_name: q('postToolUse'), cwd: q(big()) });
  const r = await runMain('cursor', text);
  assert.notEqual(r.exit, 2);
  assert.match(r.out, NOTICE);
  assert.ok(!r.out.includes('BBBB'));
});

test('a normal-size event is not treated as oversized', async () => {
  const text = build(['hook_event_name', 'session_id', 'cwd', 'tool_name', 'tool_input', 'tool_response'],
    { hook_event_name: q('PostToolUse'), session_id: q('s'), cwd: q('/'), tool_name: q('Bash'), tool_input: q({ command: 'ls' }), tool_response: q('hello') });
  const r = await runMain('claude-code', text);
  assert.doesNotMatch(r.out, NOTICE);
  assert.doesNotMatch(r.err, /too large/);
});

test('topLevelKeys: top-level keys in any order, nothing from deeper levels or strings', () => {
  const k = runner.topLevelKeys;
  assert.equal(k('{"a":1,"hook_event_name":"PostToolUse"}').hook_event_name, 'PostToolUse');
  assert.equal(k('{"hook_event_name":"PostToolUse","a":1}').hook_event_name, 'PostToolUse');
  assert.equal(k('  \n{ "a" : [ {"hook_event_name":"X"} ] , "hook_event_name" : "Real" }').hook_event_name, 'Real');
  assert.equal(k('{"a":"\\"hook_event_name\\":\\"X\\"","b":"{","hook_event_name":"Real"}').hook_event_name, 'Real');
  assert.equal(k('{"a":{"b":{"hook_event_name":"X"}}}').hook_event_name, undefined);
  assert.equal(k('{"a":["hook_event_name",{"hook_event_name":"X"}]}').hook_event_name, undefined);
  assert.equal(k('{"a":"hook_event_name"}').hook_event_name, undefined, 'a string value is not a key');
  assert.equal(k('{"hook\\u005fevent_name":"Real"}').hook_event_name, 'Real', 'an escaped key is read like JSON.parse reads it');
  assert.equal(k('{"hook_event_name":"A","hook_event_name":"B"}').hook_event_name, 'A');
  assert.equal(k('{"hook_event_name":5}').hook_event_name, true);
  assert.equal(k('{"tool_response":{"x":1}}').tool_response, true);
  assert.equal(k('{"a":"unterminated').hook_event_name, undefined);
  assert.equal(k('{"a":1}}{"hook_event_name":"X"}').hook_event_name, undefined, 'nothing after the object counts');
  assert.equal(k('[{"hook_event_name":"X"}]'), null);
  assert.equal(k(''), null);
  assert.equal(k('hello'), null);
  assert.equal(Object.getPrototypeOf(k('{}')), null);
  assert.equal(k('{"__proto__":{"hook_event_name":"X"}}').hook_event_name, undefined);
});

test('topLevelKeys: 33 MiB with many keys and strings is scanned in one linear pass', () => {
  const parts = [];
  for (let i = 0; i < 200000; i++) parts.push('"k' + i + '":{"hook_event_name":"N","x":["a\\"b",1]}');
  const text = '{' + parts.join(',') + ',"hook_event_name":"Real","pad":"' + 'x'.repeat(CAP) + '"}';
  const t = Date.now();
  const keys = runner.topLevelKeys(text);
  const ms = Date.now() - t;
  assert.equal(keys.hook_event_name, 'Real');
  assert.ok(ms < 3000, 'scanned in ' + ms + ' ms');
});
