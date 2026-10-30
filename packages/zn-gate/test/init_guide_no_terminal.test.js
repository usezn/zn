'use strict';

// zn-gate init (guided setup) without a terminal, for each supported agent, in a temporary home: the steps
// that are printed, that nothing is written to disk, and the text when a program is missing.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { guide: realGuide } = require('../lib/init-guide');
const { tempDir } = require('./helpers/tmp');

const AGENTS = {
  'claude-code': { dir: '.claude', name: 'Claude Code' },
  codex: { dir: '.codex', name: 'Codex CLI' },
  cursor: { dir: '.cursor', name: 'Cursor' },
  opencode: { dir: path.join('.config', 'opencode'), name: 'OpenCode' },
};

function machine(t, id, extraEnv = {}) {
  const home = tempDir(t, 'zn-noterm-home-');
  fs.mkdirSync(path.join(home, AGENTS[id].dir), { recursive: true });
  // XDG_CONFIG_HOME is set so a variable of the real machine never decides where OpenCode is looked for.
  const env = { HOME: home, PATH: '', XDG_CONFIG_HOME: path.join(home, '.config'), ...extraEnv };
  return { home, env, cwd: tempDir(t, 'zn-noterm-cwd-'), claude: null, ancestry: () => null };
}

// The final check probes the hooks and keeps its own evidence log in .zn of the home; that log is the only
// thing it writes, so it is left out: what must not change is the agents' configuration and the folder.
function snapshot(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && e.name === '.zn') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { out.push('d ' + path.relative(root, p)); walk(p); }
      else out.push('f ' + path.relative(root, p) + ' ' + fs.readFileSync(p, 'utf8'));
    }
  };
  walk(root);
  return out.sort();
}

async function run(m, extra = {}) {
  let text = '';
  let ran = 0;
  const code = await realGuide({
    ...m, nodeVersion: '22.0.0', temporary: false, stdin: { isTTY: false }, write: (x) => { text += x; },
    run: () => { ran++; return true; }, confirm: async () => { ran++; return true; }, ...extra,
  });
  return { code, text, ran };
}

for (const id of Object.keys(AGENTS)) {
  test('no terminal, ' + id + ': the steps are printed and nothing is written to disk', async (t) => {
    const m = machine(t, id);
    const homeBefore = snapshot(m.home);
    const cwdBefore = snapshot(m.cwd);
    const { code, text, ran } = await run(m);
    assert.equal(code, 1);
    assert.equal(ran, 0);
    assert.match(text, /This is not an interactive terminal, so zn only prints the steps\. Nothing was changed\./);
    assert.match(text, /Run them in your own terminal:/);
    assert.match(text, /Then check that it works: `npx -y zn-gate check`/);
    if (id === 'claude-code') {
      assert.match(text, /\/plugin marketplace add usezn\/zn/);
      assert.match(text, /\/plugin install zn-gate@usezn/);
    } else {
      assert.match(text, new RegExp('^ {2}zn hooks install ' + id + '$', 'm'));
    }
    assert.deepEqual(snapshot(m.home), homeBefore);
    assert.deepEqual(snapshot(m.cwd), cwdBefore);
  });
}

test('no terminal, OpenCode: it is listed by name and the other agents are not found', async (t) => {
  const { text } = await run(machine(t, 'opencode'));
  assert.match(text, />\s+OpenCode\s+not set up yet/);
  assert.match(text, /Claude Code\s+not found on this machine/);
  assert.match(text, /Codex CLI\s+not found on this machine/);
  assert.match(text, /Cursor\s+not found on this machine/);
});

test('no terminal, missing claude command: the plugin commands are typed in Claude Code, not run', async (t) => {
  const m = machine(t, 'claude-code');
  const { text, ran } = await run(m, { claude: null });
  assert.equal(ran, 0);
  assert.match(text, /in Claude Code, type \/plugin marketplace add usezn\/zn and then \/plugin install zn-gate@usezn/);
  assert.doesNotMatch(text, /claude plugin (?:marketplace add|install)/);
});

test('no terminal, claude command found: the two claude plugin commands are printed, not run', async (t) => {
  const m = machine(t, 'claude-code');
  const { text, ran } = await run(m, { claude: path.resolve('/opt/bin/claude') });
  assert.equal(ran, 0);
  assert.match(text, /^ {2}claude plugin marketplace add usezn\/zn$/m);
  assert.match(text, /^ {2}claude plugin install zn-gate@usezn$/m);
  assert.doesNotMatch(text, /in Claude Code, type/);
});

test('no terminal, missing npm from a temporary copy: the global install is a plain command to run yourself', async (t) => {
  const m = machine(t, 'codex');
  const { text, ran } = await run(m, { temporary: true, global: {} });
  assert.equal(ran, 0);
  assert.match(text, /^ {2}npm install -g zn-gate$/m);
  assert.match(text, /^ {2}zn hooks install codex$/m);
  const lines = text.split('\n');
  assert.ok(lines.indexOf('  npm install -g zn-gate') < lines.indexOf('  zn hooks install codex'));
});
