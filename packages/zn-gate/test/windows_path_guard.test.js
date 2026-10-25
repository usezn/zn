'use strict';
process.env.ZN_STATS = 'off';

// Windows hook scripts (user launcher and project guard): before any program is looked up on the PATH, the PATH keeps only its
// absolute entries and cmd.exe stops looking in the current folder first, so a zn.cmd, node.exe or node.bat planted in the
// repository (the folder the agent runs in) or in a relative PATH entry is never started. The scripts run on Windows only:
// here their text is checked; the behavior is checked on a Windows machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const launcher = require('../lib/agents/launcher');
const { parseCommand } = require('../lib/check')._internal;

const PREFIX = "$env:NoDefaultCurrentDirectoryInExePath = '1'; $env:PATH = (($env:PATH -split ';') -match '^([A-Za-z]:\\\\|\\\\\\\\)') -join ';'; ";
const AGENTS = ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'antigravity', 'zcode'];
const EVENTS = [undefined, 'PreToolUse', 'PostToolUse', 'preToolUse', 'BeforeTool', 'beforeShellExecution'];
const N = 'C:/Program Files/nodejs/node.exe';
const R = 'C:/Users/u/AppData/Roaming/npm/node_modules/zn-gate/lib/hooks/runner.js';

function scripts() {
  const out = [];
  for (const a of AGENTS) {
    for (const e of EVENTS) {
      for (const opts of [{}, { deadlineS: 28 }]) {
        let s = null;
        try { s = launcher.windowsScript(a, e, N, R, opts); } catch (_) {}
        if (s) out.push([a + ' ' + e + ' launcher' + (opts.deadlineS ? ' deadline' : ''), s]);
      }
      let p = null;
      try { p = launcher.projectWindowsScript(a, e); } catch (_) {}
      if (p) out.push([a + ' ' + e + ' project', p]);
    }
  }
  return out;
}

test('every Windows hook script cleans the PATH and turns off the current-folder search before it looks anything up', () => {
  const all = scripts();
  assert.ok(all.length > 20);
  for (const [name, s] of all) {
    const at = s.indexOf(PREFIX);
    assert.ok(at > 0, name + ': no PATH guard');
    assert.equal(s.indexOf(PREFIX, at + 1), -1, name + ': PATH guard twice');
    assert.ok(at < s.indexOf('function zf('), name + ': PATH guard after zf');
    assert.ok(at < s.indexOf("zf 'zn.cmd'"), name + ': PATH guard after the zn.cmd lookup');
  }
});

test('the PATH filter keeps drive and UNC paths only (the same pattern, read as a JavaScript regex)', () => {
  const pattern = /'(\^\(\[A-Za-z\]:[^']+)'/.exec(PREFIX)[1];
  const re = new RegExp(pattern);
  for (const ok of ['C:\\Program Files\\nodejs', 'c:\\x', '\\\\server\\share\\bin']) assert.ok(re.test(ok), ok);
  for (const bad of ['.', '', 'bin', '.\\bin', 'C:bin', '\\bin', '"C:\\quoted"', '..\\x']) assert.equal(re.test(bad), false, bad);
});

test('check still reads the launcher command it wrote (node and runner), and the project guard as guarded', () => {
  for (const a of ['claude-code', 'codex', 'cursor', 'gemini']) {
    const e = a === 'cursor' ? 'preToolUse' : a === 'gemini' ? 'BeforeTool' : 'PreToolUse';
    const s = launcher.windowsScript(a, e, N, R);
    if (!s) continue;
    const r = parseCommand(launcher.windowsScriptCommand(s), a);
    assert.ok(r && (r.winScript || r.node), a + ': ' + JSON.stringify(r));
  }
  for (const a of ['claude-code', 'codex', 'cursor', 'gemini', 'copilot']) {
    const e = a === 'cursor' || a === 'copilot' ? 'preToolUse' : a === 'gemini' ? 'BeforeTool' : 'PreToolUse';
    const r = parseCommand(launcher.windowsScriptCommand(launcher.projectWindowsScript(a, e)), a);
    assert.deepEqual(r, { onPath: true, guarded: true }, a);
  }
});

test('the encoded commands stay under the 8191-character command line of cmd.exe, with long install paths', () => {
  const n = 'C:/Users/averylongusername/AppData/Roaming/nvm/v22.11.0/node.exe';
  const r = 'C:/Users/averylongusername/AppData/Roaming/npm/node_modules/zn-gate/lib/hooks/runner.js';
  for (const a of AGENTS) {
    for (const e of EVENTS) {
      let s = null;
      try { s = launcher.windowsScript(a, e, n, r, a === 'zcode' ? { deadlineS: 28 } : {}); } catch (_) {}
      if (s) assert.ok(launcher.windowsScriptCommand(s).length < 7600, a + ' ' + e + ': ' + launcher.windowsScriptCommand(s).length);
    }
  }
});
