'use strict';

// zn-gate init (guided setup): every line the guide prints fits in 100 columns and has no tab,
// for each agent it supports, with and without an AI agent running it.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { guide } = require('../lib/init-guide');
const { listAdapters } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const MAX_COLUMNS = 100;
// Where each agent's own folder lives under HOME, so that the guide finds it on a temporary HOME.
const DIRS = {
  'claude-code': ['.claude'],
  codex: ['.codex'],
  cursor: ['.cursor'],
  opencode: ['.config', 'opencode'],
  antigravity: ['.gemini', 'antigravity'],
};

async function render(t, ids, env = {}) {
  const home = tempDir(t, 'zn-guide-width-home-');
  for (const id of ids) if (DIRS[id]) fs.mkdirSync(path.join(home, ...DIRS[id]), { recursive: true });
  let text = '';
  await guide({
    home,
    env: { HOME: home, PATH: '', ...env },
    cwd: tempDir(t, 'zn-guide-width-cwd-'),
    claude: null,
    ancestry: () => null,
    nodeVersion: '22.0.0',
    temporary: false,
    stdin: { isTTY: false },
    write: (x) => { text += x; },
  });
  return text;
}

function assertFits(text, label) {
  assert.ok(text.length > 0, label + ': the guide printed something');
  for (const l of text.split('\n')) {
    assert.ok(!l.includes('\t'), label + ': tab in line: ' + JSON.stringify(l));
    assert.ok([...l].length <= MAX_COLUMNS, label + ': ' + [...l].length + ' columns: ' + JSON.stringify(l));
  }
}

for (const id of listAdapters()) {
  test('init guide width: ' + id + ' alone, in a terminal-less run', async (t) => {
    assertFits(await render(t, [id]), id);
  });
  test('init guide width: ' + id + ' alone, run by an AI agent', async (t) => {
    assertFits(await render(t, [id], { ZN_AGENT: '1' }), id + ' (AI agent)');
  });
}

test('init guide width: every agent together, and none at all', async (t) => {
  assertFits(await render(t, listAdapters()), 'all agents');
  assertFits(await render(t, listAdapters(), { ZN_AGENT: '1' }), 'all agents (AI agent)');
  assertFits(await render(t, []), 'no agent');
  assertFits(await render(t, [], { ZN_AGENT: '1' }), 'no agent (AI agent)');
});
