'use strict';

// The Codex plugin and `zn hooks install codex` must register the same events with the same matchers,
// so that installing zn-gate as a plugin does not leave MCP calls, approval prompts, session starts
// or final answers unchecked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const codex = require('../lib/agents/codex');

const hooksFile = path.join(__dirname, '..', '..', '..', 'plugins', 'zn-gate', 'com.openai', 'hooks.json');
const plugin = JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks;
const installed = codex.hookGroups(() => ({ type: 'command' }));

test('the plugin registers the same events as the CLI install', () => {
  assert.deepEqual(Object.keys(plugin).sort(), Object.keys(installed).sort());
});

test('each plugin event has the same matcher as the CLI install', () => {
  for (const [event, group] of Object.entries(installed)) {
    assert.equal(plugin[event].length, 1, event);
    assert.equal(plugin[event][0].matcher, group.matcher, event);
  }
});

test('each plugin event runs one zn hook with the CLI install timeout and status', () => {
  for (const [event, groups] of Object.entries(plugin)) {
    const hooks = groups.flatMap((g) => g.hooks);
    assert.equal(hooks.length, 1, event);
    assert.equal(hooks[0].timeout, codex.HOOK_TIMEOUT_S, event);
    assert.equal(hooks[0].statusMessage, codex.HOOK_STATUS, event);
    assert.match(hooks[0].command, new RegExp('zn-node\.sh" ' + event + ' hook codex$'), event);
  }
});

test('the plugin matches MCP calls before they run and when Codex asks for approval', () => {
  for (const event of ['PreToolUse', 'PermissionRequest']) {
    const re = new RegExp(plugin[event][0].matcher);
    assert.ok(re.test('mcp__github__create_issue'), event);
    assert.ok(re.test('Bash'), event);
    assert.ok(re.test('apply_patch'), event);
  }
});
