'use strict';

// zn-gate stats: these tests must never count into the real ~/.zn/stats.json.
process.env.ZN_STATS = 'off';

// Codex PreToolUse for MCP tools: the hook runs for them, and their arguments
// get the same check as other agents' MCP calls. Values are fake (fixtures generator).

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

const FAKE = generateAll(5150, { perType: 1, piiPerType: 1 });
const AWS = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;

const codex = getAdapter('codex');
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const cx = (event, extra) => ({ session_id: 's', transcript_path: '/t', cwd: extra.cwd || '/', hook_event_name: event, model: 'm', ...extra });

function tmpProject(t) {
  const dir = tempDir(t, 'zn-codex-mcp-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function run(adapter, raw, extra = {}) {
  return runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --', ...extra });
}

// Run fn with CODEX_HOME pointing at a fresh directory; the variable is restored afterwards.
async function withCodexHome(t, fn) {
  const home = tempDir(t, 'zn-codex-home-');
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before;
  }
}

// A fake zn-gate install (outside the project), so the strict matcher of zn's own server can accept it.
function fakeZnSecretsArgs(t) {
  const pkg = path.join(tempDir(t, 'zn-install-'), 'zn-gate');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'zn-gate' }));
  const cli = path.join(pkg, 'bin', 'cli.js').replace(/\\/g, '/');
  fs.writeFileSync(cli, '// test double\n');
  return { command: 'node', args: [cli, 'secrets-mcp', '--agent', 'codex'] };
}

test('codex: the installed PreToolUse matcher covers MCP tools, and Bash and apply_patch keep their matcher', async (t) => {
  await withCodexHome(t, (home) => {
    const env = { CODEX_HOME: home };
    const file = codex.hooksFile({ env });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A hooks file from the previous install: the matcher must be replaced, not duplicated.
    fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '^(Bash|apply_patch)$', hooks: [{ type: 'command', command: 'node /old/zn-gate/lib/hooks/runner.js codex' }] }] } }));
    codex.install({ env, nodePath: '/usr/bin/node', runnerPath: RUNNER, mcp: false });
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pre = data.hooks.PreToolUse.filter((g) => g.hooks.some((h) => h.command && h.command.includes('runner.js')));
    assert.equal(pre.length, 1);
    assert.equal(pre[0].matcher, '^(Bash|apply_patch|mcp__.+)$');
    assert.equal(pre[0].matcher, codex.PRE_MATCHER);
    const re = new RegExp(codex.PRE_MATCHER);
    for (const name of ['Bash', 'apply_patch', 'mcp__github__create_issue', 'mcp__secrets__secrets_http_request']) assert.ok(re.test(name), name);
    for (const name of ['Read', 'mcp', 'mcp__', 'xmcp__github__get', 'Bash2']) assert.ok(!re.test(name), name);
    assert.equal(codex.POST_MATCHER, '.*');
  });
});

test('codex: an MCP call with a secret-looking argument is denied, and the value is not printed', async (t) => {
  const dir = tmpProject(t);
  const r = await run(codex, cx('PreToolUse', { cwd: dir, tool_name: 'mcp__github__create_issue', tool_input: { body: 'key ' + AWS } }));
  assert.equal(r.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.output.hookSpecificOutput.permissionDecisionReason, /AWS key/);
  assert.match(r.output.hookSpecificOutput.permissionDecisionReason, /the MCP server github/);
  assert.ok(!JSON.stringify(r.output).includes(AWS));
  // Nested arguments are checked too.
  const nested = await run(codex, cx('PreToolUse', { cwd: dir, tool_name: 'mcp__github__create_issue', tool_input: { issue: { notes: ['x', 'key ' + AWS] } } }));
  assert.equal(nested.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(!JSON.stringify(nested.output).includes(AWS));
});

test('codex: a __ZN_ marker in an MCP call to another server is denied, and zn\'s own server may take it', async (t) => {
  const dir = tmpProject(t);
  const other = await run(codex, cx('PreToolUse', { cwd: dir, tool_name: 'mcp__postgres__query', tool_input: { password: '__ZN_DB_PASSWORD__' } }));
  assert.equal(other.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(other.output.hookSpecificOutput.permissionDecisionReason, /secrets_http_request/);
  await withCodexHome(t, async (home) => {
    const { command, args } = fakeZnSecretsArgs(t);
    const toml = '[mcp_servers.secrets]\ncommand = ' + JSON.stringify(command) + '\nargs = ' + JSON.stringify(args) + '\n';
    fs.writeFileSync(path.join(home, 'config.toml'), toml);
    const own = await run(codex, cx('PreToolUse', { cwd: dir, tool_name: 'mcp__secrets__secrets_http_request', tool_input: { url: 'https://api.example.com', headers: { Authorization: 'Bearer __ZN_DB_PASSWORD__' } } }));
    assert.equal(own.output, null, 'zn\'s own server takes markers by design');
    const ownCred = await run(codex, cx('PreToolUse', { cwd: dir, tool_name: 'mcp__secrets__secrets_http_request', tool_input: { key: AWS } }));
    assert.equal(ownCred.output.hookSpecificOutput.permissionDecision, 'deny', 'its own server still gets the credential check');
    assert.ok(!JSON.stringify(ownCred.output).includes(AWS));
  });
});

test('codex: a "secrets" MCP server that is not zn\'s own install gets no marker exception', async (t) => {
  const dir = tmpProject(t);
  // No config.toml at all: the name alone is not enough.
  await withCodexHome(t, async () => {
    const nameOnly = await run(codex, cx('PreToolUse', { cwd: dir, tool_name: 'mcp__secrets__secrets_http_request', tool_input: { token: '__ZN_DB_PASSWORD__' } }));
    assert.equal(nameOnly.output.hookSpecificOutput.permissionDecision, 'deny');
  });
  // A config.toml that names another program for the same server name.
  await withCodexHome(t, async (home) => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.secrets]\ncommand = "node"\nargs = ["/opt/evil/evil.js", "secrets-mcp", "--agent", "codex"]\n');
    const spoof = await run(codex, cx('PreToolUse', { cwd: dir, tool_name: 'mcp__secrets__x', tool_input: { token: '__ZN_DB_PASSWORD__' } }));
    assert.equal(spoof.output.hookSpecificOutput.permissionDecision, 'deny');
  });
});

test('codex: a benign MCP call gets no answer (the agent\'s own approval applies)', async (t) => {
  const dir = tmpProject(t);
  const r = await run(codex, cx('PreToolUse', { cwd: dir, tool_name: 'mcp__github__list_issues', tool_input: { repo: 'usezn/zn', state: 'open' } }));
  assert.equal(r.decision.decision, 'allow');
  assert.equal(r.output, null);
  const empty = await run(codex, cx('PreToolUse', { cwd: dir, tool_name: 'mcp__github__list_issues' }));
  assert.equal(empty.output, null);
});
