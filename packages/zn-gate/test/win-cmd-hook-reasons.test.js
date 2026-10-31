'use strict';
/* Hook reasons and the launcher's repair step name the .cmd forms on Windows; POSIX output is unchanged. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const launcher = require('../lib/agents/launcher');
const { getAdapter } = require('../lib/agents');

// Commands printed by a hook: the lines that print a reason or a warning (not the header comment).
const printed = (script) => script.split('\n').filter((l) => l.includes('printf')).join('\n');

test('launcher script on win32: the hook reasons name zn.cmd and zn-gate.cmd', () => {
  const script = launcher.unixScript('codex', '/usr/bin/node', '/x/runner.js', { platform: 'win32', runnerDigest: '' });
  const lines = printed(script);
  // The repair step: npm install -g zn-gate, then zn hooks install (the launcher's FIX text).
  assert.match(lines, /npm install -g zn-gate/);
  assert.ok(lines.includes('zn.cmd hooks install codex'), 'repair step names zn.cmd');
  assert.ok(lines.includes('zn-gate.cmd check'), 'check step names zn-gate.cmd');
  assert.doesNotMatch(lines, /[^.\w]zn hooks install/);
  assert.doesNotMatch(lines, /[^.\w]zn-gate check/);
});

test('launcher script on linux keeps the plain forms', () => {
  const script = launcher.unixScript('codex', '/usr/bin/node', '/x/runner.js', { platform: 'linux', runnerDigest: '' });
  const lines = printed(script);
  assert.ok(lines.includes('zn hooks install codex'));
  assert.ok(lines.includes('zn-gate check'));
  assert.ok(!script.includes('.cmd'));
});

test('antigravity install on win32: the install warnings name zn-gate.cmd check', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-b2304-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const opts = {
    home,
    nodePath: 'C:\Program Files\nodejs\node.exe',
    runnerPath: 'C:\zn\lib\hooks\runner.js',
    env: { ZN_HOME: path.join(home, '.zn') },
  };
  const win = getAdapter('antigravity').install({ ...opts, platform: 'win32' });
  const winText = win.warnings.join('\n');
  assert.ok(winText.includes('Run `zn-gate.cmd check` to see that the hook works.'));
  assert.doesNotMatch(winText, /[^.\w]zn-gate check/);

  const posix = getAdapter('antigravity').install({ ...opts, home: fs.mkdtempSync(path.join(os.tmpdir(), 'zn-b2304-')), platform: 'linux' });
  const posixText = posix.warnings.join('\n');
  assert.ok(posixText.includes('Run `zn-gate check` to see that the hook works.'));
  assert.ok(!posixText.includes('.cmd'));
});

// Prose stays as it is: win32 and linux launcher texts differ only between backticks.
test('launcher texts on win32 differ from linux only inside backticks, for every agent', () => {
  const spans = (s) => s.replace(/`[^`\n]+`/g, '``');
  const ids = ['claude-code', 'codex', 'cursor', 'opencode', 'antigravity', 'zcode', 'copilot', 'gemini'];
  let checked = 0;
  for (const id of ids) {
    let win; let lin;
    try {
      win = launcher.unixScript(id, '/usr/bin/node', '/x/runner.js', { platform: 'win32', runnerDigest: '' });
      lin = launcher.unixScript(id, '/usr/bin/node', '/x/runner.js', { platform: 'linux', runnerDigest: '' });
    } catch (e) { continue; }
    assert.equal(spans(win), spans(lin), id + ': a sentence outside backticks changed on win32');
    assert.match(win, /`[^`\n]*\.cmd[^`\n]*`/, id + ': a command in backticks names .cmd');
    checked++;
  }
  assert.ok(checked >= 6);
});
