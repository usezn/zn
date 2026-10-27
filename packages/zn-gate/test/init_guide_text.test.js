'use strict';

// zn-gate init (guided setup): the text it prints for each agent, what it says when no agent is known,
// and that the printed text never contains the absolute paths of the machine it runs on.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { guide, plan } = require('../lib/init-guide');
const { tempDir } = require('./helpers/tmp');

function machine(t, agents) {
  const home = tempDir(t, 'zn-guide-text-home-');
  const dirs = { 'claude-code': '.claude', codex: '.codex', cursor: '.cursor' };
  for (const a of agents) fs.mkdirSync(path.join(home, dirs[a]), { recursive: true });
  return { home, env: { HOME: home, PATH: '' }, cwd: tempDir(t, 'zn-guide-text-cwd-'), claude: null, ancestry: () => null };
}

async function printed(m, extra = {}) {
  let s = '';
  const code = await guide({
    ...m, nodeVersion: '22.0.0', temporary: false, stdin: { isTTY: false }, write: (x) => { s += x; }, ...extra,
  });
  return { code, text: s };
}

test('guide text: Claude Code gets the plugin commands to type', async (t) => {
  const { text } = await printed(machine(t, ['claude-code']));
  assert.match(text, /\/plugin marketplace add usezn\/zn/);
  assert.match(text, /\/plugin install zn-gate@usezn/);
  assert.doesNotMatch(text, /zn hooks install claude-code/);
});

test('guide text: Codex CLI and Cursor get zn hooks install for their own id', async (t) => {
  const { text } = await printed(machine(t, ['codex', 'cursor']));
  assert.match(text, /zn hooks install codex/);
  assert.match(text, /zn hooks install cursor/);
  assert.doesNotMatch(text, /zn hooks install opencode/);
});

test('guide text: an agent that is not found is listed as not found and gets no step', async (t) => {
  const m = machine(t, ['codex']);
  const { items } = await plan({ ...m, nodeVersion: '22.0.0', temporary: false });
  const cursor = items.find((i) => i.id === 'cursor');
  assert.equal(cursor.found, false);
  assert.deepEqual(cursor.steps, []);
  const { text } = await printed(m);
  assert.match(text, /Cursor\s+not found on this machine/);
  assert.doesNotMatch(text, /zn hooks install cursor/);
});

test('guide text: an unknown agent is never offered; with no known agent nothing is changed', async (t) => {
  const m = machine(t, []);
  const { items } = await plan({ ...m, nodeVersion: '22.0.0', temporary: false });
  assert.ok(!items.some((i) => i.id === 'not-an-agent'));
  assert.ok(items.every((i) => !i.found && i.steps.length === 0));
  const { code, text } = await printed(m);
  assert.equal(code, 1);
  assert.match(text, /No supported coding agent was found/);
  assert.match(text, /Nothing was changed\./);
  assert.doesNotMatch(text, /zn hooks install/);
});

test('guide text: the output has no absolute path of the home, the working folder or the temp folder', async (t) => {
  const m = machine(t, ['claude-code', 'codex', 'cursor']);
  for (const stdin of [{ isTTY: false }, { isTTY: true }]) {
    const { text } = await printed(m, { stdin, confirm: async () => false, run: () => true });
    assert.ok(text.length > 0);
    for (const p of [m.home, m.cwd, path.dirname(m.home), path.join(__dirname, '..')]) {
      assert.ok(!text.includes(p), 'output contains ' + p);
    }
    assert.doesNotMatch(text, /(?:^|[\s'"(])(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)/m);
  }
});
