'use strict';

// A tool output delivered under `toolResult` or `tool_result` is model content, scanned by the
// scanner and never turned into a file path, so malformed text there is not a reason to refuse the
// event (CONTENT_KEYS in lib/hooks/runner.js). The fail-closed malformed-text check still catches a
// bad path elsewhere on the same event.

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

test('malformed text in a toolResult / tool_result field is content and is not refused', async (t) => {
  const cwd = tempDir(t, 'zn-toolresult-');
  const adapter = getAdapter('claude-code');
  for (const key of ['toolResult', 'tool_result']) {
    for (const [name, bad] of Object.entries(BAD)) {
      const event = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'ok output text' }, [key]: 'result body ' + bad, cwd };
      await noFsCalls(bad, async (calls) => {
        const res = await runner.handle(adapter, event, { home: cwd });
        assert.deepEqual(calls, [], key + ' / ' + name + ': file calls ' + calls.join(', '));
        assert.ok(!/not valid Unicode/.test(res.decision.message || ''), key + ' / ' + name + ': ' + JSON.stringify(res.decision));
      });
    }
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
