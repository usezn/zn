'use strict';
// Windows PowerShell 5.1 runs on .NET Framework: with COR_ENABLE_PROFILING=1 (and COR_PROFILER / COR_PROFILER_PATH) in the environment
// of the agent, .NET loads that DLL into powershell.exe before the first line of a zn hook script. The scripts cannot undo it, so the
// hook launcher and the project guard refuse to run the hook and answer with the block (or the warning) of the agent. Static checks:
// the scripts are not run on Windows here (the Windows CI job runs the launcher tests).
const test = require('node:test');
const assert = require('node:assert/strict');
const launcher = require('../lib/agents/launcher');
const loaderEnv = require('../lib/loader-env');
const { _internal: { parseCommand } } = require('../lib/check');

const N = 'C:/Program Files/nodejs/node.exe';
const R = 'C:/Users/u/AppData/Roaming/npm/node_modules/zn-gate/lib/hooks/runner.js';
const COND = "if ($env:COR_ENABLE_PROFILING -eq '1') { $zt=9; $zr='";
const CASES = [['claude-code', 'PreToolUse', {}], ['codex', 'PreToolUse', {}], ['cursor', 'preToolUse', {}], ['gemini', 'BeforeTool', {}],
  ['copilot', 'preToolUse', {}], ['antigravity', 'PreToolUse', {}], ['zcode', 'PreToolUse', { deadlineS: 8 }], ['claude-code', 'PostToolUse', {}]];

test('the PowerShell condition reads COR_ENABLE_PROFILING=1 only (powershell.exe is .NET Framework)', () => {
  assert.equal(loaderEnv.psProfilerOn(), "($env:COR_ENABLE_PROFILING -eq '1')");
});

test('hook launcher: a .NET profiler skips the hook and answers with the profiler text, before node or zn.cmd can run', () => {
  for (const [agent, event, opts] of CASES) {
    const s = launcher.windowsScript(agent, event, N, R, opts);
    assert.ok(s, agent);
    const at = s.indexOf(COND);
    assert.ok(at > 0, agent + ': the profiler check is in the script');
    assert.match(s.slice(at + COND.length), /^zn(?: is NOT protecting this session)?: (?:blocked, )?COR_ENABLE_PROFILING loads a DLL into the hook\./, agent);
    // Both ways to run the hook come after it, and both need $zt to be 0, which the profiler check sets to 9.
    for (const run of ['if (!$zt -and [System.IO.File]::Exists($zn)', "if (($zt -eq 0) -and (zf 'zn.cmd')"]) {
      const i = s.indexOf(run);
      assert.ok(i > at, agent + ': ' + run);
    }
    // The answer at the end reads $zr, and the paths are written once.
    assert.ok(s.includes('$zr'), agent);
    assert.equal(s.split("'" + N + "'").length - 1, 1, agent + ': node path once');
    assert.equal(s.split("'" + R + "'").length - 1, 1, agent + ': runner path once');
    // check still reads the node and runner of the launcher it wrote.
    const r = parseCommand(launcher.windowsScriptCommand(s), agent);
    assert.ok(r && r.winScript && r.node === N && r.runner === R, agent + ': ' + JSON.stringify(r && { node: r.node, runner: r.runner }));
  }
});

test('project guard: a .NET profiler skips zn and answers with the profiler text', () => {
  for (const [agent, event] of CASES) {
    const s = launcher.projectWindowsScript(agent, event);
    const at = s.indexOf(COND);
    assert.ok(at > 0, agent + ': the profiler check is in the guard');
    const run = s.indexOf("if (($zt -eq 0) -and (zg 'zn.cmd')");
    assert.ok(run > at, agent + ': zn.cmd runs only after the check, and only with $zt 0');
    // The crash text replaces the missing text only when zn ran ($zt 1), never the profiler text ($zt 9).
    assert.match(s, /if \(\$zt -eq 1\) \{ \$zr='zn/, agent);
    assert.deepEqual(parseCommand(launcher.windowsScriptCommand(s), agent), { onPath: true, guarded: true }, agent);
  }
});

test('the profiler texts are safe in a sh guard, a PowerShell literal and a JSON string', () => {
  for (const [agent, event] of CASES) {
    const s = launcher.projectWindowsScript(agent, event);
    const m = /\$zt=9; \$zr='([^']*)' \}/.exec(s);
    assert.ok(m, agent);
    assert.equal(JSON.stringify(m[1]), '"' + m[1] + '"');
    assert.doesNotMatch(m[1], /['"\\$%]/);
  }
});
