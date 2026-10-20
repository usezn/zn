'use strict';

// The Codex plugin's hooks.json must install the same events and matchers as
// `zn hooks install codex` (lib/agents/codex.js hookGroups). Only the command
// differs: the plugin runs the launcher through $PLUGIN_ROOT. A drift fails here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const codex = require('../lib/agents/codex');

const PLUGIN_HOOKS = path.join(__dirname, '..', '..', '..', 'plugins', 'zn-gate', 'com.openai', 'hooks.json');
const LAUNCHER = /^node "\$PLUGIN_ROOT\/scripts\/zn-launch\.js" hook codex$/;

function summarize(hooksByEvent) {
  const out = {};
  for (const [event, groups] of Object.entries(hooksByEvent)) {
    out[event] = groups.map((g) => ({
      matcher: g.matcher === undefined ? null : g.matcher,
      hooks: g.hooks.map((h) => ({ timeout: h.timeout, statusMessage: h.statusMessage })),
    }));
  }
  return out;
}

test('codex plugin hooks.json matches the installer events, matchers and hook settings', () => {
  const plugin = JSON.parse(fs.readFileSync(PLUGIN_HOOKS, 'utf8')).hooks;
  const installer = codex.hookGroups({ type: 'command', command: 'x', timeout: codex.HOOK_TIMEOUT_S, statusMessage: codex.HOOK_STATUS });
  // The installer writes one group per event; build the same shape from hookGroups.
  const expected = {};
  for (const [event, group] of Object.entries(installer)) expected[event] = [group];
  assert.deepEqual(summarize(plugin), summarize(expected));
});

test('codex plugin hooks.json runs the launcher in the plugin command form', () => {
  const plugin = JSON.parse(fs.readFileSync(PLUGIN_HOOKS, 'utf8')).hooks;
  for (const [event, groups] of Object.entries(plugin)) {
    for (const g of groups) {
      for (const h of g.hooks) assert.match(h.command, LAUNCHER, event + ': ' + h.command);
    }
  }
});

test('codex plugin PreToolUse and PermissionRequest cover Bash, apply_patch and MCP tools', () => {
  const plugin = JSON.parse(fs.readFileSync(PLUGIN_HOOKS, 'utf8')).hooks;
  const re = new RegExp(plugin.PreToolUse[0].matcher);
  for (const name of ['Bash', 'apply_patch', 'mcp__secrets__secrets_list']) assert.ok(re.test(name), name);
  assert.equal(plugin.PermissionRequest[0].matcher, plugin.PreToolUse[0].matcher);
});
