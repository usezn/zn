'use strict';

// zn-gate stats: these tests must never count into the real ~/.zn/stats.json.
process.env.ZN_STATS = 'off';

// Codex PermissionRequest: zn answers only "deny", and only for calls its PreToolUse
// check denies. Values are fake (fixtures generator).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { generateAll } = require('./fixtures/fake_secrets');
const { tempDir } = require('./helpers/tmp');

const FAKE = generateAll(5151, { perType: 1, piiPerType: 1 });
const AWS = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;

const codex = getAdapter('codex');
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const cx = (event, extra) => ({ session_id: 's', transcript_path: '/t', cwd: extra.cwd || '/', hook_event_name: event, model: 'm', turn_id: 't1', ...extra });

function tmpProject(t) {
  const dir = tempDir(t, 'zn-codex-permreq-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  // A .env with a value: zn denies reads of it.
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=' + AWS + '\n');
  return dir;
}

function run(adapter, raw, extra = {}) {
  return runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --', ...extra });
}

// Run fn with CODEX_HOME pointing at a fresh directory; the variable is restored afterwards.
async function withCodexHome(t, fn) {
  const home = tempDir(t, 'zn-codex-permreq-home-');
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before;
  }
}

// The only keys a PermissionRequest answer from zn may have.
function assertDenyOnly(output) {
  const text = JSON.stringify(output);
  assert.ok(!text.includes('"allow"'), 'never allow');
  assert.ok(!text.includes('updatedInput'), 'no updatedInput');
  assert.ok(!text.includes('updatedPermissions'), 'no updatedPermissions');
  assert.ok(!text.includes('interrupt'), 'no interrupt');
}

test('codex PermissionRequest: a dangerous command gets deny in the Codex shape, with the PreToolUse reason', async (t) => {
  const dir = tmpProject(t);
  const pre = await run(codex, cx('PreToolUse', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'cat .env' } }));
  const r = await run(codex, cx('PermissionRequest', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'cat .env' } }));
  assert.deepEqual(Object.keys(r.output), ['hookSpecificOutput']);
  assert.equal(r.output.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(r.output.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(r.output.hookSpecificOutput.decision.message, pre.output.hookSpecificOutput.permissionDecisionReason);
  assert.equal(r.output.hookSpecificOutput.permissionDecision, undefined);
  assertDenyOnly(r.output);

  // A marker command: the deny tells the user the zn run command, as PreToolUse does.
  const wrap = await run(codex, cx('PermissionRequest', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'psql "postgres://a:__ZN_DB_PASSWORD__@h/d"' } }));
  assert.equal(wrap.output.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(wrap.output.hookSpecificOutput.decision.message, /zn run -- psql "postgres:\/\/a:__ZN_DB_PASSWORD__@h\/d"/);
  assertDenyOnly(wrap.output);
});

test('codex PermissionRequest: a benign command gets no output, so the approval prompt stays', async (t) => {
  const dir = tmpProject(t);
  const r = await run(codex, cx('PermissionRequest', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  assert.equal(r.output, null);
  // A command already run through zn run: PreToolUse is silent, so is PermissionRequest.
  const wrapped = await run(codex, cx('PermissionRequest', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'zn run -- psql "postgres://a:__ZN_DB_PASSWORD__@h/d"' } }));
  assert.equal(wrapped.output, null);
});

test('codex PermissionRequest: an MCP call with a secret-looking argument gets deny, without the value', async (t) => {
  const dir = tmpProject(t);
  const r = await run(codex, cx('PermissionRequest', { cwd: dir, tool_name: 'mcp__github__create_issue', tool_input: { body: 'key ' + AWS } }));
  assert.equal(r.output.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(r.output.hookSpecificOutput.decision.message, /AWS key/);
  assert.ok(!JSON.stringify(r.output).includes(AWS));
  assertDenyOnly(r.output);
  const clean = await run(codex, cx('PermissionRequest', { cwd: dir, tool_name: 'mcp__github__get_issue', tool_input: { number: 7 } }));
  assert.equal(clean.output, null);
});

test('codex PermissionRequest: an apply_patch into ~/.zn gets deny', async () => {
  const home = require('os').homedir();
  const patch = '*** Begin Patch\n*** Update File: ' + path.join(home, '.zn', 'vault', 'secrets.age') + '\n*** End Patch';
  const r = await run(codex, cx('PermissionRequest', { cwd: '/tmp', tool_name: 'apply_patch', tool_input: { command: patch } }));
  assert.equal(r.output.hookSpecificOutput.decision.behavior, 'deny');
});

test('codex hooks file: PermissionRequest is installed with the PreToolUse matcher, and re-install is idempotent', async (t) => {
  await withCodexHome(t, (home) => {
    const env = { CODEX_HOME: home };
    const file = codex.hooksFile({ env });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The user's own hooks, and an old zn entry, must both survive the install.
    const own = { type: 'command', command: 'my-linter --check' };
    fs.writeFileSync(file, JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: 'Read', hooks: [own] }],
      PermissionRequest: [{ matcher: 'Bash', hooks: [own] }],
    } }));
    codex.install({ env, nodePath: '/usr/bin/node', runnerPath: RUNNER, mcp: false });
    codex.install({ env, nodePath: '/usr/bin/node', runnerPath: RUNNER, mcp: false });
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const zn = (groups) => (groups || []).filter((g) => g.hooks.some((h) => h.command && h.command.includes('runner.js')));
    const pr = zn(data.hooks.PermissionRequest);
    assert.equal(pr.length, 1, 'one zn group after two installs');
    assert.equal(pr[0].matcher, codex.PRE_MATCHER);
    assert.equal(pr[0].matcher, zn(data.hooks.PreToolUse)[0].matcher);
    assert.equal(pr[0].hooks.length, 1);
    assert.equal(pr[0].hooks[0].timeout, zn(data.hooks.PreToolUse)[0].hooks[0].timeout);
    // The user's hooks are kept, once each.
    const ownCount = (event) => (data.hooks[event] || []).flatMap((g) => g.hooks).filter((h) => h.command === 'my-linter --check').length;
    assert.equal(ownCount('PermissionRequest'), 1);
    assert.equal(ownCount('PreToolUse'), 1);
    // Uninstall removes the zn entry of the new event too.
    codex.uninstall({ env });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(zn(after.hooks.PermissionRequest).length, 0);
    const kept = (after.hooks.PermissionRequest || []).flatMap((g) => g.hooks).filter((h) => h.command === 'my-linter --check');
    assert.equal(kept.length, 1);
  });
});

// zn-gate stats counts each Codex call once, also when Codex asks for approval (PreToolUse, then PermissionRequest).
test('codex PermissionRequest: a call that asks for approval is counted once in zn-gate stats', async (t) => {
  const home = tempDir(t, 'zn-codex-permreq-stats-');
  const before = process.env.ZN_STATS;
  delete process.env.ZN_STATS; // this test reads the counts, so recording is on here
  try {
    // A placeholder in a plain command: PreToolUse asks, Codex then shows the prompt and PermissionRequest asks too.
    const dir = tmpProject(t);
    const bash = { tool_name: 'Bash', tool_input: { command: 'echo __ZN_AWS_KEY_1__' } };
    const pre = await run(codex, cx('PreToolUse', { cwd: dir, ...bash }), { home });
    const req = await run(codex, cx('PermissionRequest', { cwd: dir, ...bash }), { home });
    assert.equal(pre.decision.decision, 'ask');
    assert.equal(req.decision.decision, 'ask');
    assert.equal(req.output, null, 'no answer from zn: the prompt stays');
    const data = JSON.parse(fs.readFileSync(path.join(home, '.zn', 'stats.json'), 'utf8'));
    const day = Object.values(data.days)[0];
    assert.deepEqual(day['hook:codex'], { checked: 1, blocked: 0, warned: 1, redacted: 0, detections: {} });
  } finally {
    if (before === undefined) delete process.env.ZN_STATS; else process.env.ZN_STATS = before;
  }
});

// Fail closed: an engine error on PermissionRequest is a deny in the Codex PermissionRequest shape, never allow.
test('codex PermissionRequest: an engine that throws gets deny in its own shape, also when the engine fails open', async (t) => {
  const dir = tmpProject(t);
  const throwing = new Proxy({}, { get() { const e = new Error('engine exploded'); e.code = 'ZN_BOOM'; throw e; } });
  for (const failMode of ['open', 'closed']) {
    const r = await run(codex, cx('PermissionRequest', { cwd: dir, tool_name: 'mcp__github__create_issue', tool_input: { body: 'hello' } }), { engine: throwing, failMode });
    assert.deepEqual(Object.keys(r.output), ['hookSpecificOutput'], failMode);
    assert.equal(r.output.hookSpecificOutput.hookEventName, 'PermissionRequest', failMode);
    assert.equal(r.output.hookSpecificOutput.decision.behavior, 'deny', failMode);
    assert.match(r.output.hookSpecificOutput.decision.message, /something went wrong inside the zn hook/, failMode);
    assert.match(r.output.hookSpecificOutput.decision.message, /ZN_BOOM/, failMode);
    assertDenyOnly(r.output);
  }
});

// Fail closed: input the hook cannot read is refused by the process (exit 2, nothing on stdout), and its text is never echoed.
test('codex PermissionRequest: malformed stdin is refused with exit 2 and no answer, without echoing the input', async (t) => {
  const home = tempDir(t, 'zn-codex-permreq-bad-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn'), ZN_STATS: 'off', CODEX_HOME: home };
  delete env.ZN_HOOK_FAIL_MODE;
  const aws = 'AKIA' + 'Z'.repeat(16);
  for (const input of ['', 'not json ' + aws, '[1, 2]', '"PermissionRequest"']) {
    const r = spawnSync(process.execPath, [RUNNER, 'codex'], { input, env, encoding: 'utf8' });
    assert.equal(r.status, 2, JSON.stringify(input));
    assert.equal(r.stdout, '', 'no allow and no deny JSON on stdout');
    assert.match(r.stderr, /could not read this action/);
    assert.ok(!r.stderr.includes(aws), 'the input is not echoed');
  }
});
