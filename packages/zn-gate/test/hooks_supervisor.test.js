'use strict';

process.env.ZN_STATS = 'off';

// The supervisor of the whole hook (lib/hooks/runner.js armSupervisor, and the deadline of the launcher): a hook whose stdin
// never ends, whose check never finishes, or that is told to stop (SIGTERM) answers for its event with the block of its own
// agent instead of leaving the agent with nothing, which lets the call run. These tests spawn the real runner and the real
// launcher script. ZN_TEST_HOOK_* work only with ZN_TEST_HOOK_FAULTS=1 and can only shorten a deadline or make the hook wait.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const { tempDir } = require('./helpers/tmp');
const launcher = require('../lib/agents/launcher');
const { winCommandText } = require('../lib/zn-command');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const WIN = process.platform === 'win32';
// On Windows the hook names the command as zn-gate.cmd (the form that runs from a terminal), so the expected text goes through the same rewrite.
const NEXT_STEP = winCommandText('ask the user to run `zn-gate check` in their terminal');
const hasNextStep = (text) => text.includes('if it keeps happening, ' + NEXT_STEP);

// A pre-tool event of each agent (the secret path makes no difference: the check never gets to run).
const PRE = {
  'claude-code': { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } },
  codex: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'u', tool_input: { command: 'echo hi' } },
  zcode: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } },
  cursor: { hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command: 'echo hi' } },
  gemini: { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'echo hi' } },
  copilot: { toolName: 'bash', toolArgs: { command: 'echo hi' } },
  antigravity: { toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } } },
  opencode: { hook: 'tool.execute.before', tool: 'bash', args: { command: 'echo hi' } },
};

function runner(t, agent, extraEnv) {
  const home = tempDir(t, 'zn-sup-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off', ZN_TEST_HOOK_FAULTS: '1', ...extraEnv };
  const child = spawn(process.execPath, [RUNNER, agent], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const started = Date.now();
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c; });
  child.stderr.on('data', (c) => { out.stderr += c; });
  child.stdin.on('error', () => {});
  const done = new Promise((resolve) => {
    const guard = setTimeout(() => { child.kill('SIGKILL'); }, 25000);
    child.on('close', (status, signal) => { clearTimeout(guard); resolve({ ...out, status, signal, ms: Date.now() - started }); });
  });
  return { child, done };
}

function assertBlocked(agent, r) {
  assert.equal(r.status, 2, agent + ': ' + JSON.stringify(r));
  const all = r.stdout + r.stderr;
  if (agent === 'codex' || agent === 'zcode') assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  else if (agent === 'cursor') assert.equal(JSON.parse(r.stdout).permission, 'deny');
  else if (agent === 'copilot') assert.equal(JSON.parse(r.stdout).permissionDecision, 'deny');
  else if (agent === 'antigravity' || agent === 'gemini') assert.equal(JSON.parse(r.stdout).decision, 'deny');
  else assert.match(all, /blocked/); // Claude Code: exit 2 and the reason on stderr; OpenCode: exit 2
}

for (const agent of Object.keys(PRE)) {
  test(agent + ': a complete event on a stdin that never ends is blocked at the deadline', async (t) => {
    const { child, done } = runner(t, agent, { ZN_TEST_HOOK_DEADLINE_MS: '500' });
    child.stdin.write(JSON.stringify(PRE[agent])); // no end(): stdin stays open
    const r = await done;
    assertBlocked(agent, r);
    assert.ok(r.ms < 8000, 'answered in ' + r.ms + ' ms');
  });

  test(agent + ': half an event on a stdin that never ends is blocked at the deadline', async (t) => {
    const { child, done } = runner(t, agent, { ZN_TEST_HOOK_DEADLINE_MS: '500' });
    child.stdin.write(JSON.stringify(PRE[agent]).slice(0, 20));
    const r = await done;
    // Codex and ZCode: with the event name not read yet, exit 2 and the reason on stderr (their documented block).
    if (agent === 'codex' || agent === 'zcode') { assert.equal(r.status, 2, JSON.stringify(r)); assert.match(r.stderr, /blocked/); } else assertBlocked(agent, r);
  });
}

test('claude-code: a Stop event on a stdin that never ends is only warned about, never exit 2', async (t) => {
  const { child, done } = runner(t, 'claude-code', { ZN_TEST_HOOK_DEADLINE_MS: '500' });
  child.stdin.write('{"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"');
  const r = await done;
  assert.equal(r.status, 0, JSON.stringify(r));
  assert.match(r.stderr, /could not check this Stop event/);
});

test('claude-code: a PostToolUse event on a stdin that never ends gets the withheld notice', async (t) => {
  const { child, done } = runner(t, 'claude-code', { ZN_TEST_HOOK_DEADLINE_MS: '500' });
  child.stdin.write('{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_response":"');
  const r = await done;
  assert.equal(r.status, 0, JSON.stringify(r));
  assert.match(r.stdout, /withheld/);
});

// Gemini CLI and Copilot CLI let the call run when their 15 s hook timeout passes, and have no pre-tool watchdog of their own
// in the adapter: the supervisor answers before that, on its own default deadline (no shortened test deadline here).
for (const agent of ['gemini', 'copilot']) {
  test(agent + ': a check that hangs for 20 s is blocked in under 15 s on the real deadline', async (t) => {
    const { child, done } = runner(t, agent, { ZN_TEST_HOOK_FAULT: 'hang', ZN_TEST_HOOK_HANG_MS: '20000' });
    child.stdin.end(JSON.stringify(PRE[agent]));
    const r = await done;
    assertBlocked(agent, r);
    assert.ok(r.ms < 14000, 'answered in ' + r.ms + ' ms');
    assert.ok(r.ms > 5000, 'not before it had to: ' + r.ms + ' ms');
  });
}

// One next step for every timeout, whatever the agent: zn-gate check (not zn-gate doctor, not a reinstall).
test('a check that runs out of time gives every agent the same next step', async (t) => {
  for (const agent of ['claude-code', 'codex', 'zcode', 'cursor', 'gemini', 'antigravity']) {
    const { child, done } = runner(t, agent, { ZN_TEST_HOOK_FAULT: 'hang', ZN_TEST_HOOK_HANG_MS: '20000', ZN_TEST_HOOK_DEADLINE_MS: '500' });
    child.stdin.end(JSON.stringify(PRE[agent]));
    const r = await done;
    const all = r.stdout + r.stderr;
    assert.ok(hasNextStep(all), agent + ': ' + all);
    assert.doesNotMatch(all, /zn-gate doctor|hooks install/, agent);
  }
});

test('zcode: a post-tool event whose check runs out of time gets the timeout notice (not withheld), not a block', async (t) => {
  const post = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_response: 'hi' };
  const { child, done } = runner(t, 'zcode', { ZN_TEST_HOOK_FAULT: 'hang', ZN_TEST_HOOK_HANG_MS: '20000', ZN_TEST_HOOK_DEADLINE_MS: '500' });
  child.stdin.end(JSON.stringify(post));
  const r = await done;
  assert.equal(r.status, 0, JSON.stringify(r));
  assert.doesNotMatch(r.stdout + r.stderr, /so it was blocked|so this was blocked/);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  const note = out.hookSpecificOutput.additionalContext;
  assert.match(note, /the check timed out/, note);
  assert.match(note, /It was NOT withheld/, note);
  assert.doesNotMatch(note, /withheld because|too large/, note);
  assert.ok(note.includes(NEXT_STEP), note);
});

test('claude-code: a post-tool event whose check runs out of time keeps the withheld text', async (t) => {
  const post = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_response: 'hi' };
  const { child, done } = runner(t, 'claude-code', { ZN_TEST_HOOK_FAULT: 'hang', ZN_TEST_HOOK_HANG_MS: '20000', ZN_TEST_HOOK_DEADLINE_MS: '500' });
  child.stdin.end(JSON.stringify(post));
  const r = await done;
  assert.equal(r.status, 0, JSON.stringify(r));
  assert.match(r.stdout + r.stderr, /withheld because it is too large to check for secrets in time/, r.stdout + r.stderr);
});

test('the deadline of every agent is its hook timeout minus the margin of the supervisor', () => {
  for (const agent of Object.keys(PRE)) {
    const a = require('../lib/agents/' + agent);
    const seconds = a.HOOK_TIMEOUT_S || a.HOOK_TIMEOUT_MS / 1000;
    assert.ok(seconds >= 10, agent + ' has a host timeout the supervisor can sit under');
  }
});

test('a vault that does not answer ends at the deadline of the hook, not after 15 s', async (t) => {
  if (WIN) return t.skip('Unix domain socket');
  const vault = require('../lib/vault/client');
  const home = tempDir(t, 'zn-sup-vault-');
  fs.mkdirSync(path.join(home, 'run'), { recursive: true, mode: 0o700 });
  const ep = vault.endpoint({ home });
  fs.writeFileSync(ep.keyFile, 'a'.repeat(64), { mode: 0o600 });
  const key = Buffer.from('a'.repeat(64), 'hex');
  const serverNonce = 'b'.repeat(32);
  const server = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      let nl;
      while ((nl = data.indexOf('\n')) >= 0) {
        const msg = JSON.parse(data.slice(0, nl));
        data = data.slice(nl + 1);
        if (msg.op === 'hello') socket.write(JSON.stringify({ ok: true, v: 1, nonce: serverNonce, proof: vault.hmac(key, 'zn-server', msg.nonce, serverNonce) }) + '\n');
        else if (msg.op === 'auth') socket.write(JSON.stringify({ ok: true }) + '\n');
        // every other call is never answered
      }
    });
  });
  await new Promise((resolve) => server.listen(ep.address, resolve));
  const c = vault.createClient({ home });
  process.env.ZN_HOOK_VAULT_WAIT_MS = '400';
  const started = Date.now();
  try {
    await assert.rejects(c.maskInfo(home));
  } finally {
    delete process.env.ZN_HOOK_VAULT_WAIT_MS;
    try { await c.close(); } catch (_) { /* closed */ }
    server.close();
  }
  assert.ok(Date.now() - started < 5000, 'ended in ' + (Date.now() - started) + ' ms');
});

test('the runner on SIGTERM during a pre-tool event answers with the block of its agent', async (t) => {
  if (WIN) return t.skip('no signals');
  for (const agent of ['codex', 'gemini', 'claude-code']) {
    const { child, done } = runner(t, agent, { ZN_TEST_HOOK_FAULT: 'hang', ZN_TEST_HOOK_HANG_MS: '20000' });
    child.stdin.end(JSON.stringify(PRE[agent]));
    await new Promise((r) => setTimeout(r, 2500)); // long enough for a loaded machine to start node and arm the handler
    child.kill('SIGTERM');
    const r = await done;
    assertBlocked(agent, r);
    assert.ok(r.ms < 8000, agent + ' ended in ' + r.ms + ' ms');
  }
});

// The launcher script (a POSIX sh script) around a runner that is stuck.
function launcherRun(t, agent, event, hookSource, opts, drive) {
  const dir = tempDir(t, 'zn-sup-launch-');
  const hook = path.join(dir, 'hook.js');
  fs.writeFileSync(hook, hookSource);
  const file = path.join(dir, 'launch.sh');
  fs.writeFileSync(file, launcher.unixScript(agent, process.execPath, hook, opts), { mode: 0o755 });
  const child = spawn('/bin/sh', [file, event], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: dir } });
  const started = Date.now();
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c; });
  child.stderr.on('data', (c) => { out.stderr += c; });
  child.stdin.on('error', () => {});
  const done = new Promise((resolve) => child.on('close', (status, signal) => resolve({ ...out, status, signal, ms: Date.now() - started })));
  if (drive) drive(child);
  return { child, done, dir };
}

const HANG = 'process.stdin.resume(); setInterval(() => {}, 1000);'; // reads stdin, never ends, never answers

for (const [agent, event, deny] of [['gemini', 'BeforeTool', (r) => assert.equal(r.status, 2)], ['claude-code', 'PreToolUse', (r) => assert.equal(r.status, 2)], ['codex', 'PermissionRequest', (r) => assert.match(r.stdout, /"behavior":"deny"/)]]) {
  test('launcher ' + agent + ' ' + event + ': a hook stuck on stdin is stopped and blocked at the launcher deadline', async (t) => {
    if (WIN) return t.skip('POSIX launcher');
    const { child, done } = launcherRun(t, agent, event, HANG, { deadlineS: 1, deadlineSoft: true });
    child.stdin.write('{"hook_event_name":"' + event + '"'); // stdin stays open
    const r = await done;
    deny(r);
    assert.ok(r.ms < 6000, 'answered in ' + r.ms + ' ms');
  });

  test('launcher ' + agent + ' ' + event + ': SIGTERM makes the launcher answer with the block, not exit 143', async (t) => {
    if (WIN) return t.skip('POSIX launcher');
    const { child, done } = launcherRun(t, agent, event, HANG, { deadlineS: 30, deadlineSoft: true });
    child.stdin.write('{"hook_event_name":"' + event + '"');
    await new Promise((r) => setTimeout(r, 600));
    child.kill('SIGTERM');
    const r = await done;
    assert.notEqual(r.status, 143);
    deny(r);
    assert.ok(r.ms < 6000, 'answered in ' + r.ms + ' ms');
  });
}

test('launcher: a non-blocking event (PostToolUse) is not blocked on SIGTERM, only warned', async (t) => {
  if (WIN) return t.skip('POSIX launcher');
  const { child, done } = launcherRun(t, 'claude-code', 'PostToolUse', HANG, { deadlineS: 30, deadlineSoft: true });
  child.stdin.write('{}');
  await new Promise((r) => setTimeout(r, 600));
  child.kill('SIGTERM');
  const r = await done;
  assert.equal(r.status, 0);
  assert.match(r.stdout, /NOT protecting/);
});

test('launcher: a hook that finishes in time passes its answer through unchanged (soft mode)', async (t) => {
  if (WIN) return t.skip('POSIX launcher');
  const { child, done } = launcherRun(t, 'gemini', 'BeforeTool', 'process.stdin.resume(); process.stdin.on("end", () => { require("fs").writeFileSync(process.env.ZN_HOOK_ACK, "ok"); process.stdout.write("{\\"decision\\":\\"allow\\"}"); });', { deadlineS: 5, deadlineSoft: true });
  child.stdin.end('{}');
  const r = await done;
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{"decision":"allow"}');
});
