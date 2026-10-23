'use strict';

// The Claude Code plugin and `zn hooks install claude-code` must hook the same tools.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PRE_MATCHER, POST_MATCHER } = require('../lib/agents/claude-code');

const hooksFile = path.join(__dirname, '..', '..', '..', 'plugins', 'zn-gate', 'hooks', 'hooks.json');

test('the plugin hooks the same tools as the CLI install', () => {
  const plugin = JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks;
  assert.equal(plugin.PreToolUse[0].matcher, PRE_MATCHER);
  assert.equal(plugin.PostToolUse[0].matcher, POST_MATCHER);
});

test('MCP tool calls are matched before and after they run', () => {
  for (const m of [PRE_MATCHER, POST_MATCHER]) {
    assert.ok(new RegExp(m).test('mcp__github__create_issue'), m);
    assert.ok(new RegExp(m).test('Bash'), m);
    assert.ok(!new RegExp(m).test('Glob'), m);
  }
});
