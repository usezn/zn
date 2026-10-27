'use strict';

// zn-gate check reads the Windows launcher that `zn hooks install zcode` writes (an inline PowerShell script that runs
// the hook as a child with a deadline, functions zf and zr) as zn's hook, like the launchers of the other agents.
// Values are fake; everything runs in a temporary home and no PowerShell is started.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { getAdapter } = require('../lib/agents');
const check = require('../lib/check');
const shellQuote = require('../lib/shell-quote');
const launcher = require('../lib/agents/launcher');
const { tempDir } = require('./helpers/tmp');

const { parseCommand, hookEntries } = check._internal;
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const RUNNER = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\zn-gate\\lib\\hooks\\runner.js';

function installWindows(t) {
  const home = tempDir(t, 'zn-zcw-');
  const zc = getAdapter('zcode');
  zc.install({ home, env: { HOME: home, ZN_HOME: path.join(home, '.zn') }, platform: 'win32', nodePath: NODE, runnerPath: RUNNER });
  const cfgPath = path.join(home, '.zcode', 'cli', 'config.json');
  return { home, cfgPath, tree: JSON.parse(fs.readFileSync(cfgPath, 'utf8')) };
}

test('check reads the exact ZCode Windows command the installer writes, for every event', (t) => {
  const { tree } = installWindows(t);
  const entries = hookEntries(tree, 'zcode').filter((e) => /-EncodedCommand/.test(e.command));
  assert.ok(entries.length >= 3, 'the installer wrote the Windows launcher for the events');
  for (const e of entries) {
    assert.match(shellQuote.windowsCommandScript(e.command), /function zr\(\$f, \$a\)/);
    const p = parseCommand(e.command, 'zcode');
    assert.ok(p && p.winScript, e.event + ' is recognised as zn\'s launcher');
    assert.equal(p.node, NODE.replace(/\\/g, '/'));
    assert.equal(p.runner, RUNNER.replace(/\\/g, '/'));
  }
});

test('check does not read that command as zn\'s hook for another agent, or when the agent in it differs', (t) => {
  const { tree } = installWindows(t);
  const e = hookEntries(tree, 'zcode').find((x) => /-EncodedCommand/.test(x.command));
  assert.equal(parseCommand(e.command, 'cursor'), null);
  const script = shellQuote.windowsCommandScript(e.command);
  const other = launcher.windowsScriptCommand(script.replace('runner.js" zcode', 'runner.js" codex'));
  assert.equal(parseCommand(other, 'zcode'), null);
});

test('check reports ZCode set up (not "not set up") after a Windows install', async (t) => {
  const { home } = installWindows(t);
  const cwd = tempDir(t, 'zn-zcw-cwd-');
  const r = (await check.check({ home, cwd, env: { ...process.env, HOME: home }, live: false })).results.find((x) => x.id === 'zcode');
  assert.notEqual(r.state, 'not-set-up');
});

test('the Windows launchers of the other agents are still read by check', (t) => {
  for (const [id, event] of [['cursor', 'preToolUse'], ['gemini', 'BeforeTool'], ['codex', 'PreToolUse'], ['antigravity', 'PreToolUse']]) {
    const script = launcher.windowsScript(id, event, NODE, RUNNER);
    const p = parseCommand(launcher.windowsScriptCommand(script), id);
    assert.ok(p && p.winScript, id + ' launcher is recognised');
  }
});
