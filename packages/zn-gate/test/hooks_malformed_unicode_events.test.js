'use strict';

// A post-tool, prompt or expansion event with malformed text in a path field is refused before any file call.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { tempDir } = require('./helpers/tmp');

const BAD = {
  'lone surrogate': 'a' + String.fromCharCode(0xD800) + 'b',
  'U+10FFFF': 'a' + String.fromCodePoint(0x10FFFF) + 'b',
  NUL: 'a' + String.fromCharCode(0) + 'b',
};

// Only calls that carry the event's own text count: the config and stats files are read from fixed places.
function noFsCalls(mark, fn) {
  const names = ['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'realpathSync', 'openSync', 'readFileSync', 'createReadStream'];
  const saved = {};
  const calls = [];
  for (const n of names) {
    saved[n] = fs[n];
    fs[n] = (...a) => { if (typeof a[0] === 'string' && a[0].includes(mark)) calls.push(n + ' ' + JSON.stringify(a[0])); return saved[n](...a); };
  }
  return fn(calls).finally(() => { for (const n of names) fs[n] = saved[n]; });
}

const EVENTS = (t, cwd) => ({
  'post_tool, bad cwd': [{ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'ok output text' }, cwd: cwd + '/' + t }, 'post_tool'],
  'post_tool, bad path in input': [{ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/work/' + t }, tool_response: { content: 'file text here' }, cwd }, 'post_tool'],
  'post_tool, bad transcript path': [{ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok output text', transcript_path: t, cwd }, 'post_tool'],
  'user_prompt, bad cwd': [{ hook_event_name: 'UserPromptSubmit', prompt: 'hello there friend', cwd: cwd + '/' + t }, 'user_prompt'],
  'prompt_expansion, bad cwd': [{ hook_event_name: 'UserPromptExpansion', prompt: 'hello there friend', cwd: cwd + '/' + t }, 'prompt_expansion'],
});

test('post-tool, prompt and expansion events with malformed paths fail closed without a file call', async (t) => {
  const cwd = tempDir(t, 'zn-badtext-all-');
  const adapter = getAdapter('claude-code');
  for (const [name, text] of Object.entries(BAD)) {
    for (const [label, [event, kind]] of Object.entries(EVENTS(text, cwd))) {
      await noFsCalls(text, async (calls) => {
        const res = await runner.handle(adapter, event, { home: cwd });
        const d = res.decision;
        assert.deepEqual(calls, [], label + ' / ' + name + ': file calls ' + calls.join(', '));
        assert.equal(d.failClosed !== undefined || d.updatedOutput !== undefined, true, label + ' / ' + name + ': ' + JSON.stringify(d));
        assert.match(d.message, /characters zn cannot read/, label + ' / ' + name);
        if (kind === 'post_tool') {
          assert.doesNotMatch(JSON.stringify(d.updatedOutput), /ok output|file text/, 'the output is withheld');
          assert.match(JSON.stringify(d.updatedOutput), /hidden/);
        } else {
          assert.equal(d.decision, 'deny', label + ' / ' + name);
          assert.ok(d.userMessage, 'the person is told why');
        }
      });
    }
  }
});

test('malformed text in a tool output or a prompt body is content, not a path, and is not refused', async (t) => {
  const cwd = tempDir(t, 'zn-badtext-content-');
  const adapter = getAdapter('claude-code');
  const bad = BAD['lone surrogate'];
  const post = await runner.handle(adapter, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'output ' + bad }, cwd }, { home: cwd });
  assert.ok(!/characters zn cannot read/.test(post.decision.message || ''), JSON.stringify(post.decision));
  const prompt = await runner.handle(adapter, { hook_event_name: 'UserPromptSubmit', prompt: 'hello ' + bad + ' there', cwd }, { home: cwd });
  assert.ok(!/characters zn cannot read/.test(prompt.decision.message || ''), JSON.stringify(prompt.decision));
});
