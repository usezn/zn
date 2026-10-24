'use strict';
process.env.ZN_STATS = 'off';

// Project installs (`zn hooks install <agent> --project`) share the hooks file through the repository, so the command names `zn`
// on the PATH. A bare `zn hook <agent>` fails open when `zn` or Node.js cannot start (exit 127: every agent runs the call). Each
// agent's project install now writes the same start guard Antigravity has: if zn or node cannot start, the hook answers that
// agent's own blocking response. These tests run the written command with the real sh, with zn missing, node missing or zn crashing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getAdapter } = require('../lib/agents');
const launcher = require('../lib/agents/launcher');
const cfg = require('../lib/agents/config-file');
const { windowsCommandScript } = require('../lib/shell-quote');
const { tempDir } = require('./helpers/tmp');

const skip = { skip: process.platform === 'win32' };
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

function whichSh() {
  for (const d of String(process.env.PATH || '').split(':')) {
    const f = path.join(d, 'sh');
    if (d && fs.existsSync(f)) return fs.realpathSync(f);
  }
  return '/bin/sh';
}

/* A folder that is the whole PATH: sh, and optionally a fake zn and a node. */
function mkbin(t, { zn, node } = {}) {
  const bin = tempDir(t, 'zn-pg-bin-');
  fs.symlinkSync(whichSh(), path.join(bin, 'sh'));
  if (zn !== undefined && zn !== null) { fs.writeFileSync(path.join(bin, 'zn'), '#!' + whichSh() + '\n' + zn + '\n'); fs.chmodSync(path.join(bin, 'zn'), 0o755); }
  if (node) fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  return bin;
}

// The agent runs the command through a shell.
function run(command, bin, input = '{}') {
  return spawnSync(whichSh(), ['-c', command], { input, encoding: 'utf8', env: { PATH: bin }, cwd: '/' });
}

// agent -> how the project install is made, which file it writes and where the commands are, and the blocking answer.
const AGENTS = {
  'claude-code': { file: ['.claude', 'settings.json'], block: 'PreToolUse', warn: 'PostToolUse', mode: 'exit2', commands: (d) => [].concat(...Object.entries(d.hooks).map(([e, gs]) => gs.map((g) => [e, g.hooks[0].command]))) },
  codex: { file: ['.codex', 'hooks.json'], block: 'PreToolUse', warn: 'PostToolUse', mode: 'exit2', commands: (d) => [].concat(...Object.entries(d.hooks).map(([e, gs]) => gs.map((g) => [e, g.hooks[0].command]))) },
  cursor: { file: ['.cursor', 'hooks.json'], block: 'preToolUse', warn: 'postToolUse', mode: 'exit2', commands: (d) => [].concat(...Object.entries(d.hooks).map(([e, hs]) => hs.map((h) => [e, h.command]))) },
  gemini: { file: ['.gemini', 'settings.json'], block: 'BeforeTool', warn: null, mode: 'exit2', commands: (d) => [].concat(...Object.entries(d.hooks).map(([e, gs]) => gs.map((g) => [e, g.hooks[0].command]))) },
  copilot: { file: ['.github', 'hooks', 'zn-gate.json'], block: 'preToolUse', warn: 'postToolUse', mode: 'json', commands: (d) => [].concat(...Object.entries(d.hooks).map(([e, hs]) => hs.map((h) => [e, h.bash]))) },
};

function install(t, agent, extra = {}) {
  const dir = tempDir(t, 'zn-pg-proj-');
  const home = tempDir(t, 'zn-pg-home-');
  getAdapter(agent).install({ scope: 'project', projectDir: dir, home, env: { HOME: home }, mcp: false, managedDir: path.join(home, 'no-managed-policy'), ...extra });
  const spec = AGENTS[agent];
  const data = JSON.parse(fs.readFileSync(path.join(dir, ...spec.file), 'utf8'));
  return { dir, home, data, commands: spec.commands(data) };
}

for (const agent of Object.keys(AGENTS)) {
  const spec = AGENTS[agent];

  test(agent + ': the project install writes the guarded command, not a bare `zn hook`', skip, (t) => {
    const { commands } = install(t, agent);
    assert.ok(commands.length >= 1);
    for (const [event, command] of commands) {
      assert.notEqual(command, 'zn hook ' + agent, event);
      assert.ok(command.startsWith('sh -c '), event);
      assert.ok(launcher.isProjectGuard(command, agent), event);
      assert.ok(cfg.isOurs(command, agent), event);
    }
    assert.ok(commands.some(([e]) => e === spec.block));
  });

  test(agent + ': zn missing, node missing or both: the blocking event answers the agent\'s block (a bare command was exit 127)', skip, (t) => {
    const { commands } = install(t, agent);
    const command = commands.find(([e]) => e === spec.block)[1];
    // Before the fix the written command was `zn hook <agent>`: with no zn on the PATH it exits 127, which every agent runs through.
    assert.equal(run('zn hook ' + agent, mkbin(t, { node: true })).status, 127);
    for (const bin of [mkbin(t, { node: true }), mkbin(t, { zn: 'exit 0' }), mkbin(t, {})]) {
      const r = run(command, bin);
      if (spec.mode === 'exit2') {
        assert.equal(r.status, 2, r.stdout + r.stderr);
        assert.match(r.stderr, /npm install -g zn-gate/);
      } else {
        assert.equal(r.status, 0, r.stderr);
        const o = JSON.parse(r.stdout);
        assert.equal(o.permissionDecision, 'deny');
        assert.match(o.permissionDecisionReason, /npm install -g zn-gate/);
      }
    }
  });

  test(agent + ': zn starts and then fails (exit 1, 127, a crash): the blocking event blocks and points to zn-gate check', skip, (t) => {
    const { commands } = install(t, agent);
    const command = commands.find(([e]) => e === spec.block)[1];
    for (const body of ['exit 1', 'exit 127', 'kill -9 $$']) {
      const r = run(command, mkbin(t, { node: true, zn: body }));
      if (spec.mode === 'exit2') {
        assert.equal(r.status, 2, body);
        assert.match(r.stderr, /zn-gate check/);
      } else {
        assert.equal(r.status, 0, body);
        assert.equal(JSON.parse(r.stdout).permissionDecision, 'deny', body);
      }
    }
  });

  test(agent + ': zn and node found: the hook runs `zn hook ' + agent + '`, the input goes through, an answer and a refusal pass unchanged', skip, (t) => {
    const { commands } = install(t, agent);
    const command = commands.find(([e]) => e === spec.block)[1];
    const seen = path.join(tempDir(t, 'zn-pg-in-'), 'in.json');
    const ok = run(command, mkbin(t, { node: true, zn: '/bin/cat > ' + JSON.stringify(seen) + '; echo "ran $1 $2"' }), '{"x":1}');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'ran hook ' + agent);
    assert.equal(fs.readFileSync(seen, 'utf8'), '{"x":1}');
    const refused = run(command, mkbin(t, { node: true, zn: 'echo own-refusal >&2; exit 2' }));
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /own-refusal/);
  });

  test(agent + ': the events that cannot block only warn, and never exit 127', skip, (t) => {
    const { commands } = install(t, agent);
    if (!spec.warn) return;
    for (const [event, command] of commands.filter(([e]) => e === spec.warn)) {
      const r = run(command, mkbin(t, { node: true }));
      assert.equal(r.status, 0, event + ' ' + r.stderr);
      assert.match(r.stdout + r.stderr, /NOT protecting this session|blocked/, event);
    }
  });

  test(agent + ': a zn that is only on a relative PATH entry is not run', skip, (t) => {
    const { commands } = install(t, agent);
    const command = commands.find(([e]) => e === spec.block)[1];
    const bin = mkbin(t, { node: true });
    const work = tempDir(t, 'zn-pg-rel-');
    fs.writeFileSync(path.join(work, 'zn'), '#!/bin/sh\necho planted\n');
    fs.chmodSync(path.join(work, 'zn'), 0o755);
    const r = spawnSync(whichSh(), ['-c', command], { input: '{}', encoding: 'utf8', env: { PATH: '.:' + bin }, cwd: work });
    assert.ok(!/planted/.test(r.stdout));
    assert.ok(r.status === 2 || /"permissionDecision":"deny"/.test(r.stdout), r.stdout + r.stderr);
  });

  test(agent + ': the written project command is recognized by check, and a bare one is not', skip, (t) => {
    const { commands } = install(t, agent);
    const parse = require('../lib/check')._internal.parseCommand;
    for (const [, command] of commands) assert.deepEqual(parse(command, agent), { onPath: true, guarded: true });
    assert.deepEqual(parse('zn hook ' + agent, agent), { onPath: true });
  });
}

test('the guard works with dash and bash as the outer shell', skip, (t) => {
  const { commands } = install(t, 'claude-code');
  const command = commands.find(([e]) => e === 'PreToolUse')[1];
  const shells = ['dash', 'bash'].map((n) => ['/bin', '/usr/bin'].map((d) => path.join(d, n)).find((f) => fs.existsSync(f))).filter(Boolean);
  assert.ok(shells.length >= 1);
  for (const shell of shells) {
    const r = spawnSync(shell, ['-c', command], { input: '{}', encoding: 'utf8', env: { PATH: mkbin(t, { node: true }) } });
    assert.equal(r.status, 2, shell);
    assert.match(r.stderr, /npm install -g zn-gate/);
  }
});

test('with the real zn hook behind it, the project command of each agent answers the real decision', skip, (t) => {
  const { commands } = install(t, 'claude-code');
  const command = commands.find(([e]) => e === 'PreToolUse')[1];
  const bin = mkbin(t, { node: true, zn: 'exec "' + process.execPath + '" "' + RUNNER + '" "$2"' });
  const home = tempDir(t, 'zn-pg-real-');
  const read = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(home, '.ssh', 'id_rsa') }, cwd: home });
  const r = spawnSync(whichSh(), ['-c', command], { input: read, encoding: 'utf8', env: { PATH: bin, HOME: home, USERPROFILE: home, ZN_STATS: 'off' } });
  assert.match(r.stdout, /"permissionDecision":"deny"/, r.stdout + r.stderr);
  assert.match(r.stdout, /id_rsa|secrets/, r.stdout);
});

test('OpenCode: the project plugin fails closed by itself when `zn` cannot start (no guard needed)', skip, async (t) => {
  const dir = tempDir(t, 'zn-pg-oc-');
  const home = tempDir(t, 'zn-pg-ochome-');
  getAdapter('opencode').install({ scope: 'project', projectDir: dir, home, env: { HOME: home } });
  const src = fs.readFileSync(path.join(dir, '.opencode', 'plugins', 'zn-gate.js'), 'utf8');
  const file = path.join(tempDir(t, 'zn-pg-ocmod-'), 'plugin.mjs');
  fs.writeFileSync(file, src);
  const oldPath = process.env.PATH;
  process.env.PATH = mkbin(t, {});
  try {
    const mod = await import(file);
    const hooks = await mod.ZnGate({ directory: dir });
    await assert.rejects(() => hooks['tool.execute.before']({ tool: 'bash', sessionID: 's' }, { args: { command: 'ls' } }), /call blocked/);
  } finally { process.env.PATH = oldPath; }
});

test('Windows: each agent\'s project hook is a PowerShell script without cmdlets, with the same steps, and isOurs and check find it', (t) => {
  const parse = require('../lib/check')._internal.parseCommand;
  const cases = [
    ['codex', 'PreToolUse', /Console\]::Error\.WriteLine\('zn: its hook cannot start because zn or Node\.js was not found/, / exit 2 \}/],
    ['codex', 'PermissionRequest', /"behavior":"deny"/, null],
    ['cursor', 'preToolUse', /"permission":"deny"/, null],
    ['gemini', 'BeforeTool', /"decision":"deny"/, null],
    ['copilot', 'preToolUse', /"permissionDecision":"deny"/, null],
    ['claude-code', 'PostToolUse', /"systemMessage":"zn is NOT protecting this session/, null],
  ];
  for (const [agent, event, answer, ex] of cases) {
    const command = launcher.windowsScriptCommand(launcher.projectWindowsScript(agent, event));
    const script = windowsCommandScript(command);
    assert.ok(launcher.isProjectWindowsScript(script, agent), agent + ' ' + event);
    assert.match(script, answer, agent + ' ' + event);
    if (ex) assert.match(script, ex);
    assert.match(script, /# zn hook [a-z-]+$/);
    assert.ok(!/\b(Test-Path|Get-Command|New-Object|Write-Output|Write-Host)\b/.test(script), 'no cmdlet');
    assert.ok(cfg.isOurs(command, agent));
    assert.deepEqual(parse(command, agent), { onPath: true, guarded: true });
  }
});

test('Windows: codex and copilot write a PowerShell command next to the sh one; cursor and gemini write it on win32', (t) => {
  const cx = install(t, 'codex', { platform: 'win32' });
  const h = JSON.parse(fs.readFileSync(path.join(cx.dir, '.codex', 'hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0];
  assert.ok(h.command.startsWith('sh -c '));
  assert.match(h.commandWindows, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /);
  assert.ok(launcher.isProjectWindowsScript(windowsCommandScript(h.commandWindows), 'codex'));
  const cp = install(t, 'copilot', { platform: 'win32' });
  const ph = JSON.parse(fs.readFileSync(path.join(cp.dir, '.github', 'hooks', 'zn-gate.json'), 'utf8')).hooks.preToolUse[0];
  assert.match(ph.powershell, /^powershell\.exe /);
  assert.ok(launcher.isProjectWindowsScript(windowsCommandScript(ph.powershell), 'copilot'));
  for (const [agent, file] of [['cursor', ['.cursor', 'hooks.json']], ['gemini', ['.gemini', 'settings.json']]]) {
    const r = install(t, agent, { platform: 'win32' });
    const text = fs.readFileSync(path.join(r.dir, ...file), 'utf8');
    const cmds = [...text.matchAll(/"command": "(powershell\.exe [^"]+)"/g)].map((m) => m[1]);
    assert.ok(cmds.length >= 1, agent);
    for (const c of cmds) assert.ok(launcher.isProjectWindowsScript(windowsCommandScript(c), agent), agent);
  }
});

test('install --project is idempotent and uninstall removes the guarded hook', skip, (t) => {
  for (const agent of ['claude-code', 'codex', 'cursor', 'gemini', 'copilot']) {
    const spec = AGENTS[agent];
    const r = install(t, agent);
    getAdapter(agent).install({ scope: 'project', projectDir: r.dir, home: r.home, env: { HOME: r.home }, mcp: false, managedDir: path.join(r.home, 'no-managed-policy') });
    const again = spec.commands(JSON.parse(fs.readFileSync(path.join(r.dir, ...spec.file), 'utf8')));
    assert.equal(again.length, r.commands.length, agent);
    assert.equal(getAdapter(agent).uninstall({ scope: 'project', projectDir: r.dir, home: r.home, env: { HOME: r.home }, mcp: false, managedDir: path.join(r.home, 'no-managed-policy') }).removed, 1, agent);
  }
});

test('check: a bare `zn hook` in a project file is reported as not protected; the guarded one is not', async (t) => {
  const { check } = require('../lib/check');
  const home = tempDir(t, 'zn-pg-chk-');
  for (const agent of ['claude-code', 'codex', 'cursor', 'gemini', 'copilot']) {
    const spec = AGENTS[agent];
    const proj = tempDir(t, 'zn-pg-chkrepo-');
    const guarded = tempDir(t, 'zn-pg-chkrepo2-');
    getAdapter(agent).install({ scope: 'project', projectDir: guarded, home, env: { HOME: home }, mcp: false, managedDir: path.join(home, 'no-managed-policy') });
    getAdapter(agent).install({ scope: 'project', projectDir: proj, home, env: { HOME: home }, mcp: false, managedDir: path.join(home, 'no-managed-policy'), command: 'zn hook ' + agent });
    const env = { HOME: home, PATH: process.env.PATH };
    const find = (res) => res.results ? res.results.find((x) => x.id === agent) : (Array.isArray(res) ? res.find((x) => x.id === agent) : null);
    const bare = find(await check({ home, env, cwd: proj }));
    assert.equal(bare.state, 'not-protected', agent);
    assert.match(bare.problem, /bare `zn hook /, agent);
    assert.match(bare.fix, /--project/, agent);
    const ok = find(await check({ home, env, cwd: guarded }));
    assert.equal(ok.state, 'project-only', agent);
    void spec;
  }
});
