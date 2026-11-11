'use strict';

// GitHub Copilot delivers the tool output in toolResult.textResultForLlm (tool_result.text_result_for_llm). That text is
// model content: the scanner scans it and it never becomes a file path, so malformed text there is not a reason to refuse
// the event. The rest of the field, and the same field sent by any other agent, stays under the fail-closed check.

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

// Fails the test if any file-system call is made with a path carrying the marker string.
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

test('malformed text in the Copilot tool output (toolResult text) is content: not refused, and scanned', async (t) => {
  const cwd = tempDir(t, 'zn-toolresult-');
  const adapter = getAdapter('copilot');
  const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  for (const [key, textKey, typeKey] of [['toolResult', 'textResultForLlm', 'resultType'], ['tool_result', 'text_result_for_llm', 'result_type']]) {
    for (const [name, bad] of Object.entries(BAD)) {
      const event = { toolName: 'bash', toolArgs: JSON.stringify({ command: 'ls' }), cwd,
        [key]: { [typeKey]: 'success', [textKey]: 'token ' + secret + ' ' + bad } };
      await noFsCalls(bad, async (calls) => {
        const res = await runner.handle(adapter, event, { home: cwd });
        assert.deepEqual(calls, [], key + ' / ' + name + ': file calls ' + calls.join(', '));
        assert.ok(!/not valid Unicode/.test(res.decision.message || ''), key + ' / ' + name + ': ' + JSON.stringify(res.decision));
        assert.ok(!JSON.stringify(res.decision).includes(secret), key + ' / ' + name + ': the output is scanned and the token is not passed on');
      });
    }
  }
});

test('the same field from an agent that does not use it as the output is checked', async (t) => {
  const cwd = tempDir(t, 'zn-toolresult-other-');
  const adapter = getAdapter('claude-code');
  for (const key of ['toolResult', 'tool_result']) {
    for (const [name, bad] of Object.entries(BAD)) {
      const event = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'ok output text' }, [key]: 'result body ' + bad, cwd };
      await noFsCalls(bad, async (calls) => {
        const res = await runner.handle(adapter, event, { home: cwd });
        assert.deepEqual(calls, [], key + ' / ' + name + ': file calls ' + calls.join(', '));
        assert.match(res.decision.message || '', /not valid Unicode/, key + ' / ' + name + ': ' + JSON.stringify(res.decision));
      });
    }
  }
});

test('malformed text in another part of the Copilot toolResult is checked', async (t) => {
  const cwd = tempDir(t, 'zn-toolresult-type-');
  const adapter = getAdapter('copilot');
  for (const [name, bad] of Object.entries(BAD)) {
    const event = { toolName: 'bash', toolArgs: JSON.stringify({ command: 'ls' }), cwd,
      toolResult: { resultType: 'success', textResultForLlm: 'clean output', extra: 'x' + bad } };
    const res = await runner.handle(adapter, event, { home: cwd });
    assert.match(res.decision.message || '', /not valid Unicode/, name + ': ' + JSON.stringify(res.decision));
  }
});

test('the exemption is narrow: a bad path on the same event still fails closed before any file call', async (t) => {
  const cwd = tempDir(t, 'zn-toolresult-path-');
  const adapter = getAdapter('claude-code');
  for (const [name, bad] of Object.entries(BAD)) {
    // toolResult is clean content; the malformed text is in cwd, a path field.
    const event = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'ok output text' }, toolResult: 'clean result body', cwd: cwd + '/' + bad };
    await noFsCalls(bad, async (calls) => {
      const res = await runner.handle(adapter, event, { home: cwd });
      assert.deepEqual(calls, [], name + ': file calls ' + calls.join(', '));
      assert.match(res.decision.message || '', /not valid Unicode/, name + ': ' + JSON.stringify(res.decision));
      assert.doesNotMatch(JSON.stringify(res.decision.updatedOutput), /ok output/, 'the output is withheld');
    });
  }
});
