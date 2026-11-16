'use strict';
process.env.ZN_STATS = 'off';

// The Windows project hook script: the script made for one agent id is accepted for that id only, a non-string and a
// script with extra text at the end are refused, and an event name with a space or a digit is a bad event name.

const test = require('node:test');
const assert = require('node:assert/strict');
const launcher = require('../lib/agents/launcher');

test('a script made for an agent id is accepted for that id only', () => {
  const script = launcher.projectWindowsScript('codex');
  assert.equal(launcher.isProjectWindowsScript(script, 'codex'), true);
  assert.equal(launcher.isProjectWindowsScript(script, 'copilot'), false);
  assert.equal(launcher.isProjectWindowsScript(script, 'gemini'), false);
  assert.equal(launcher.isProjectWindowsScript(launcher.projectWindowsScript('copilot'), 'codex'), false);
});

test('a value that is not a string is refused', () => {
  for (const v of [undefined, null, 0, 1, {}, [], ['x'], true, () => 'x']) {
    assert.equal(launcher.isProjectWindowsScript(v, 'codex'), false);
  }
});

test('a script with extra text at the end is refused', () => {
  const script = launcher.projectWindowsScript('codex');
  assert.equal(launcher.isProjectWindowsScript(script + ' extra', 'codex'), false);
  assert.equal(launcher.isProjectWindowsScript(script + '\n', 'codex'), false);
  assert.equal(launcher.isProjectWindowsScript(script + '; Write-Output hi', 'codex'), false);
});

test('an event name with a space or a digit throws the bad event name error', () => {
  for (const e of ['Pre Tool', ' PreToolUse', 'PreToolUse ', 'Tool2', '1', 'a-b', '']) {
    assert.throws(() => launcher.projectWindowsScript('codex', e), /zn: bad event name/, JSON.stringify(e));
  }
  assert.doesNotThrow(() => launcher.projectWindowsScript('codex', 'PreToolUse'));
});
