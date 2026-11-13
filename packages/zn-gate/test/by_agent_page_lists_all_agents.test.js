'use strict';
// Keeps docs/by-agent.md in step with the agent registry: every agent the CLI can install
// hooks for has an install command on the page, and the page names no install id the CLI
// would reject.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { AGENT_IDS, getAdapter } = require('../lib/agents');

const docPath = path.resolve(__dirname, '..', '..', '..', 'docs', 'by-agent.md');
const present = fs.existsSync(docPath);
const skip = !present && 'repository docs not in this checkout';

function page() {
  return fs.readFileSync(docPath, 'utf8').replace(/\r/g, '');
}

// Text inside inline code spans, where the page writes its commands.
function commands(md) {
  return [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

// True when the CLI accepts `id` as an agent id or one of its aliases.
function accepted(id) {
  try { getAdapter(id); return true; } catch { return false; }
}

test('docs/by-agent.md has an install command for every agent id', { skip }, () => {
  const cmds = commands(page());
  for (const id of AGENT_IDS) {
    const re = new RegExp(' install ' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w.-])');
    assert.ok(cmds.some((c) => re.test(c)), 'docs/by-agent.md has no command with " install ' + id + '"');
  }
});

test('docs/by-agent.md names no hooks install id the CLI does not know', { skip }, () => {
  const named = [];
  for (const c of commands(page())) {
    for (const m of c.matchAll(/\bhooks (?:un)?install ([\w.-]+)/g)) named.push(m[1]);
  }
  assert.ok(named.length >= AGENT_IDS.length, 'expected hooks install commands on the page');
  for (const id of named) {
    assert.ok(accepted(id), '"' + id + '" in docs/by-agent.md is not an agent id or alias (supported: ' + AGENT_IDS.join(', ') + ')');
  }
});
