'use strict';

// A file name that a native call cannot take must never reach one. On Windows, libuv converts names with
// asserts that end the whole process (exit code 0xC0000409) for U+10000 and U+10FFFF; an agent reads a hook
// that died that way as "no opinion" and lets the action through. These tests run each hook as its own
// process, so a crash shows up as a wrong exit code here and not as a dead test run.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { isUnsafeText, hasUnsafeText } = require('../lib/safe-text');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');

// Text built from code units, so this file itself holds no malformed text.
const BAD = {
  'U+10FFFF': 'a' + String.fromCodePoint(0x10FFFF) + 'b',
  'U+10000': 'a' + String.fromCodePoint(0x10000) + 'b',
  'U+1FFFF': 'a' + String.fromCodePoint(0x1FFFF) + 'b',
  'lone high surrogate': 'a' + String.fromCharCode(0xD800) + 'b',
  'lone low surrogate': 'a' + String.fromCharCode(0xDFFF) + 'b',
  'high surrogate at the end': 'a' + String.fromCharCode(0xDBFF),
  'U+FFFE': 'a' + String.fromCharCode(0xFFFE) + 'b',
  'U+FFFF': 'a' + String.fromCharCode(0xFFFF) + 'b',
  'U+FDD0': 'a' + String.fromCharCode(0xFDD0) + 'b',
  'NUL': 'a' + String.fromCharCode(0) + 'b',
};

const GOOD = ['plain.txt', 'café/über.txt', 'dir/' + String.fromCodePoint(0x1F600) + '.md',
  String.fromCodePoint(0x10001), String.fromCodePoint(0x10FFFD), String.fromCodePoint(0x1F4A9) + String.fromCodePoint(0x10400)];

test('the guard finds every text a native call cannot take and lets real text through', () => {
  for (const [name, text] of Object.entries(BAD)) assert.equal(isUnsafeText(text), true, name);
  for (const text of GOOD) assert.equal(isUnsafeText(text), false, JSON.stringify(text));
  assert.equal(isUnsafeText(5), false);
  assert.equal(isUnsafeText(undefined), false);
});

test('the guard looks into keys, arrays and objects, and refuses a value nested absurdly deep', () => {
  assert.equal(hasUnsafeText({ a: [{ b: BAD.NUL }] }), true);
  assert.equal(hasUnsafeText({ [BAD['U+10FFFF']]: 1 }), true);
  assert.equal(hasUnsafeText({ a: ['x', { b: 'y' }], n: 1, z: null }), false);
  let deep = 'x';
  for (let i = 0; i < 100; i++) deep = { v: deep };
  assert.equal(hasUnsafeText(deep), true);
});

// One event of each agent that names a file or a command through the text under test.
const CASES = {
  'claude-code': (t, cwd) => [
    { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/work/' + t }, cwd },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat ../' + t + '/.env' }, cwd },
    { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { path: t, pattern: 'x' }, cwd },
  ],
  codex: (t, cwd) => [
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat ' + t + '/.env' }, cwd },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: cwd + '/' + t },
  ],
  cursor: (t, cwd) => [
    { hook_event_name: 'beforeReadFile', file_path: '/work/' + t, cwd },
    { hook_event_name: 'beforeShellExecution', command: 'cat ' + t + '/.env', cwd },
  ],
  opencode: (t, cwd) => [
    { hook: 'tool.execute.before', tool: 'read', args: { filePath: '/work/' + t }, cwd },
    { hook: 'tool.execute.before', tool: 'bash', args: { command: 'cat ' + t + '/.env' }, cwd },
  ],
};

function tmpHome(t) {
  return tempDir(t, 'zn-badtext-');
}

function runHook(agent, event, home) {
  return spawnSync(process.execPath, [RUNNER, agent], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ZN_HOOK_FAIL_MODE: '', ZN_STATS: 'off' },
  });
}

test('every agent adapter denies malformed text before any file call, in process', async (t) => {
  const cwd = tmpHome(t);
  for (const [agent, make] of Object.entries(CASES)) {
    const adapter = getAdapter(agent);
    for (const [name, text] of Object.entries(BAD)) {
      for (const event of make(text, cwd)) {
        const res = await runner.handle(adapter, event, { home: cwd });
        assert.equal(res.decision.decision, 'deny', agent + ' / ' + name + ': ' + JSON.stringify(res.decision));
        assert.match(res.decision.message, /not valid Unicode/, agent + ' / ' + name);
      }
    }
  }
});

test('every agent hook process survives malformed text and blocks the action', (t) => {
  const home = tmpHome(t);
  const cwd = home;
  for (const [agent, make] of Object.entries(CASES)) {
    for (const [name, text] of Object.entries(BAD)) {
      for (const event of make(text, cwd)) {
        const res = runHook(agent, event, home);
        // A crash on Windows has a status of 3221226505 (0xC0000409) or null; a block is exit 2 or a deny answer.
        assert.ok(res.status === 0 || res.status === 2, agent + ' / ' + name + ': status ' + res.status + ' ' + res.stderr);
        assert.ok(res.status === 2 || /deny/i.test(res.stdout), agent + ' / ' + name + ': not blocked: ' + res.stdout);
      }
    }
  }
});

test('a Stop, post-tool or prompt event with a malformed working directory does not crash the hook', (t) => {
  const home = tmpHome(t);
  const bad = path.join(home, BAD['U+10FFFF']);
  const events = [
    ['claude-code', { hook_event_name: 'Stop', last_assistant_message: 'done, nothing to see here', cwd: bad, transcript_path: bad }],
    ['claude-code', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'ok' }, cwd: bad }],
    ['claude-code', { hook_event_name: 'UserPromptSubmit', prompt: 'hello there', cwd: bad }],
    ['codex', { hook_event_name: 'Stop', last_assistant_message: 'done, nothing to see here', cwd: bad, transcript_path: bad }],
  ];
  for (const [agent, event] of events) {
    const res = runHook(agent, event, home);
    assert.ok(res.status === 0 || res.status === 2, agent + ' ' + event.hook_event_name + ': status ' + res.status + ' ' + res.stderr);
    if (event.hook_event_name === 'Stop') assert.equal(res.status, 0, 'a Stop event is never refused with exit code 2');
  }
});

test('ordinary non-ASCII names are not refused', async (t) => {
  const cwd = tmpHome(t);
  fs.writeFileSync(path.join(cwd, 'café.txt'), 'hello');
  const adapter = getAdapter('claude-code');
  for (const name of ['café.txt', String.fromCodePoint(0x1F600) + '.txt', String.fromCodePoint(0x10001) + '.txt']) {
    const ev = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(cwd, name) }, cwd };
    const res = await runner.handle(adapter, ev, { home: os.tmpdir() });
    assert.notEqual(res.decision.failClosed, true, name);
    assert.doesNotMatch(String(res.decision.message || ''), /not valid Unicode/, name);
  }
});
