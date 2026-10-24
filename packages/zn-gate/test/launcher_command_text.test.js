'use strict';

// The text of the launcher script and of the hook command, per agent; quoting of paths with
// spaces and quotes; an unknown agent. Values are fake and nothing is written to disk.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const launcher = require('../lib/agents/launcher');
const { getAdapter } = require('../lib/agents');

const BLOCKING = {
  'claude-code': ['PreToolUse|UserPromptSubmit|UserPromptExpansion)'],
  codex: ['PreToolUse|UserPromptSubmit)', 'PermissionRequest)'],
  cursor: ['beforeMCPExecution|beforeReadFile|beforeShellExecution|beforeSubmitPrompt|preToolUse)'],
  gemini: ['BeforeTool)'],
  antigravity: ['PreToolUse)'],
};

for (const [agent, cases] of Object.entries(BLOCKING)) {
  test('unixScript for ' + agent + ' names the agent and lists the events that block', () => {
    const lines = launcher.unixScript(agent, '/opt/node/bin/node', '/opt/zn/runner.js').split('\n');
    assert.equal(lines[0], '#!/bin/sh');
    assert.ok(lines.some((l) => l.includes('"$ZN_NODE" "$ZN_RUNNER" ' + agent + ';')));
    assert.ok(lines.some((l) => l.includes('"$ZN_CMD" hook ' + agent + ';')));
    for (const c of cases) assert.ok(lines.includes('  ' + c), agent + ' lists ' + c);
  });
}

test('unixScript: the deny JSON on stdout (exit 0) is used by antigravity only; the others exit 2', () => {
  const anti = launcher.unixScript('antigravity', '/n', '/r');
  assert.ok(anti.includes('"decision":"deny"') && anti.includes('    exit 0 ;;'));
  assert.ok(!anti.includes('    exit 2 ;;'));
  const gem = launcher.unixScript('gemini', '/n', '/r');
  assert.ok(gem.includes('    exit 2 ;;') && !gem.includes('"decision":"deny"'));
});

test('unixScript: cursor warns on stderr, claude-code warns with a systemMessage', () => {
  assert.ok(!launcher.unixScript('cursor', '/n', '/r').includes('systemMessage'));
  assert.ok(launcher.unixScript('claude-code', '/n', '/r').includes('systemMessage'));
});

test('unixScript: paths with spaces and a quote are single-quoted in the script', () => {
  const s = launcher.unixScript('gemini', '/opt/my node/bin/node', "/opt/it's here/runner.js");
  assert.ok(s.includes("ZN_NODE='/opt/my node/bin/node'\n"));
  assert.ok(s.includes('ZN_RUNNER=\'/opt/it\'"\'"\'s here/runner.js\'\n'));
});

test('unixScript and windowsScript refuse an unknown or malformed agent id', () => {
  for (const id of ['Bad;id', 'two words', '', 'agent1', '$(x)']) {
    assert.throws(() => launcher.unixScript(id, '/n', '/r'), /bad agent id/, JSON.stringify(id));
    assert.throws(() => launcher.windowsScript(id, 'PreToolUse', 'C:\\n', 'C:\\r'), /bad agent id/, JSON.stringify(id));
  }
});

test('an unknown agent has no adapter and the error lists the supported ones', () => {
  assert.throws(() => getAdapter('not-an-agent'), (e) => /unknown agent "not-an-agent"/.test(e.message) && /supported: .*cursor/.test(e.message));
  assert.throws(() => getAdapter(undefined), /unknown agent ""/);
});

test('launcherCommand quotes a path with spaces or a quote and puts the event last', () => {
  assert.equal(launcher.launcherCommand('/home/a b/.zn/hooks/zn-hook-cursor.sh', 'preToolUse', 'linux'),
    "'/home/a b/.zn/hooks/zn-hook-cursor.sh' preToolUse");
  assert.equal(launcher.launcherCommand("/home/it's/zn-hook-x.sh", 'E', 'linux'),
    "'/home/it'\"'\"'s/zn-hook-x.sh' E");
});

test('launcherCommand with plain writes no quotes, and plainPathOk tells which paths allow that', () => {
  assert.equal(launcher.launcherCommand('/home/a/.zn/hooks/zn-hook-antigravity.sh', 'PreToolUse', 'linux', { plain: true }),
    '/home/a/.zn/hooks/zn-hook-antigravity.sh PreToolUse');
  assert.equal(launcher.plainPathOk('/home/a/.zn/hooks/zn-hook-x.sh'), true);
  assert.equal(launcher.plainPathOk('/home/a b/zn-hook-x.sh'), false);
  assert.equal(launcher.plainPathOk("/home/it's/x.sh"), false);
  assert.equal(launcher.plainPathOk(''), false);
});

test('launcherFile and launcherDir follow ZN_HOME, then the home option; spaces are kept', () => {
  // The result is built with path.join and path.resolve, so it uses the separators (and, on Windows, the
  // drive letter) of the platform the test runs on.
  assert.equal(launcher.launcherFile('cursor', { env: { ZN_HOME: '/srv/zn home' } }),
    path.join(path.resolve('/srv/zn home'), 'hooks', 'zn-hook-cursor.sh'));
  assert.equal(launcher.launcherDir({ env: {}, home: '/home/a b' }), path.join('/home/a b', '.zn', 'hooks'));
});

test('windowsScript: a path with a single quote gives no script; a normal one names the agent', () => {
  assert.equal(launcher.windowsScript('cursor', 'preToolUse', "C:\\it's\\node.exe", 'C:\\r.js'), null);
  const s = launcher.windowsScript('gemini', 'BeforeTool', 'C:\\Program Files\\node\\node.exe', 'C:\\zn\\runner.js');
  assert.ok(s.includes("'C:/Program Files/node/node.exe'"));
  assert.ok(s.endsWith(' # zn hook gemini'));
});
