'use strict';

// zn-gate stats: these tests must never count into the real ~/.zn/stats.json.
process.env.ZN_STATS = 'off';

// Claude Code and OpenCode check an MCP call's arguments before the call, like
// Codex, Cursor, Gemini and Antigravity. Values are fake (fixtures generator).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const { generateAll } = require('./fixtures/fake_secrets');
const { tempDir } = require('./helpers/tmp');

const FAKE = generateAll(6161, { perType: 1, piiPerType: 1 });
const AWS = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;
// An sk- style key built at runtime, so no key-shaped literal sits in the source.
const SK = 'sk-' + 'test-EXAMPLE' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';

const claude = getAdapter('claude-code');
const opencode = getAdapter('opencode');

function tmpProject(t) {
  const dir = tempDir(t, 'zn-mcp-args-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function run(adapter, raw) {
  return runner.handle(adapter, raw, { vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
}

const ccPre = (cwd, tool_name, tool_input) => ({ session_id: 's', cwd, hook_event_name: 'PreToolUse', tool_name, tool_input });
const ocPre = (cwd, tool, args) => ({ hook: 'tool.execute.before', sessionID: 's', cwd, tool, args });

// A fake zn-gate install (outside the project), so the strict matcher of zn's own server accepts it.
function fakeZnCli(t) {
  const pkg = path.join(tempDir(t, 'zn-install-'), 'zn-gate');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'zn-gate' }));
  const cli = path.join(pkg, 'bin', 'cli.js').replace(/\\/g, '/');
  fs.writeFileSync(cli, '// test double\n');
  return cli;
}

async function withEnv(vars, fn) {
  const before = {};
  for (const k of Object.keys(vars)) { before[k] = process.env[k]; process.env[k] = vars[k]; }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
  }
}

test('claude code: the PreToolUse matcher names the listed tools and every MCP tool', () => {
  const re = new RegExp(claude.PRE_MATCHER);
  for (const name of ['Bash', 'PowerShell', 'Monitor', 'Read', 'Grep', 'LSP', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'WebFetch', 'mcp__foo__bar', 'mcp__secrets__secrets_list']) assert.ok(re.test(name), name);
  for (const name of ['Glob', 'TaskOutput', 'Bash2', 'xRead', 'xmcp__foo__bar', 'mcp_foo']) assert.ok(!re.test(name), name);
});

test('claude code: an MCP call with a secret in its arguments is denied before the call', async (t) => {
  const dir = tmpProject(t);
  for (const secret of [SK, AWS]) {
    const r = await run(claude, ccPre(dir, 'mcp__foo__bar', { body: 'key ' + secret }));
    assert.equal(r.output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(r.output.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(!JSON.stringify(r.output).includes(secret));
  }
  const nested = await run(claude, ccPre(dir, 'mcp__foo__bar', { a: { b: ['x', 'key ' + AWS] } }));
  assert.equal(nested.output.hookSpecificOutput.permissionDecision, 'deny');
  const marker = await run(claude, ccPre(dir, 'mcp__foo__bar', { password: '__ZN_DB_PASSWORD__' }));
  assert.equal(marker.output.hookSpecificOutput.permissionDecision, 'deny');
});

test('claude code: benign MCP arguments pass', async (t) => {
  const dir = tmpProject(t);
  const r = await run(claude, ccPre(dir, 'mcp__foo__bar', { query: 'list open issues', limit: 10, tags: ['a', 'b'] }));
  assert.equal(r.output, null);
  const empty = await run(claude, ccPre(dir, 'mcp__foo__bar', {}));
  assert.equal(empty.output, null);
});

test('claude code: zn\'s own secrets server takes markers only when its config names the same command', async (t) => {
  const dir = tmpProject(t);
  const home = tempDir(t, 'zn-cc-home-');
  const cli = fakeZnCli(t);
  const server = { command: 'node', args: [cli, 'secrets-mcp', '--agent', 'claude-code'] };
  const call = () => run(claude, ccPre(dir, 'mcp__secrets__secrets_http_request', { url: 'https://api.example.com', headers: { Authorization: 'Bearer __ZN_DB_PASSWORD__' } }));
  await withEnv({ CLAUDE_CONFIG_DIR: home }, async () => {
    // Not registered: no exception.
    assert.equal((await call()).output.hookSpecificOutput.permissionDecision, 'deny');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { secrets: server } }));
    assert.equal((await call()).output, null, 'its own server takes markers by design');
    const cred = await run(claude, ccPre(dir, 'mcp__secrets__secrets_http_request', { key: AWS }));
    assert.equal(cred.output.hookSpecificOutput.permissionDecision, 'deny', 'its own server still gets the credential check');
    // A project .mcp.json that redefines "secrets" with another command removes the exception.
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { secrets: { command: 'node', args: ['/evil/server.js'] } } }));
    assert.equal((await call()).output.hookSpecificOutput.permissionDecision, 'deny');
    // Another server with a similar name never gets it.
    const other = await run(claude, ccPre(dir, 'mcp__secrets__other_tool', { password: '__ZN_DB_PASSWORD__' }));
    assert.equal(other.output.hookSpecificOutput.permissionDecision, 'deny');
  });
});

test('claude code: install over an old install replaces the PreToolUse matcher, and uninstall removes it', (t) => {
  const home = tempDir(t, 'zn-cc-up-');
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-guard.sh' }] };
  const oldMatcher = 'Bash|PowerShell|Monitor|Read|Grep|LSP|Edit|MultiEdit|Write|NotebookEdit|WebFetch';
  fs.writeFileSync(file, JSON.stringify({
    hooks: {
      PreToolUse: [userHook, { matcher: oldMatcher, hooks: [{ type: 'command', command: "'/usr/bin/node' '/old/zn/lib/hooks/runner.js' claude-code", timeout: 15 }] }],
    },
  }));
  const opts = { scope: 'user', home, env: {}, mcp: false, nodePath: '/usr/bin/node', cliPath: '/opt/zn-gate/bin/cli.js', runnerPath: '/opt/zn/lib/hooks/runner.js' };
  claude.install(opts);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.hooks.PreToolUse.length, 2);
  assert.deepEqual(data.hooks.PreToolUse[0], userHook);
  assert.equal(data.hooks.PreToolUse[1].matcher, claude.PRE_MATCHER);
  assert.notEqual(data.hooks.PreToolUse[1].matcher, oldMatcher);
  assert.ok(new RegExp(data.hooks.PreToolUse[1].matcher).test('mcp__foo__bar'));
  claude.uninstall({ scope: 'user', home, env: {}, mcp: false });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after, { hooks: { PreToolUse: [userHook] } });
});

test('opencode: an MCP call with a secret in its arguments is denied before the call', async (t) => {
  const dir = tmpProject(t);
  for (const secret of [SK, AWS]) {
    const r = await run(opencode, ocPre(dir, 'foo_bar', { body: 'key ' + secret }));
    assert.equal(r.output.action, 'deny');
    assert.ok(!JSON.stringify(r.output).includes(secret));
  }
  const nested = await run(opencode, ocPre(dir, 'foo_bar', { a: { b: ['x', 'key ' + AWS] } }));
  assert.equal(nested.output.action, 'deny');
  const marker = await run(opencode, ocPre(dir, 'foo_bar', { password: '__ZN_DB_PASSWORD__' }));
  assert.equal(marker.output.action, 'deny');
});

test('opencode: benign MCP arguments pass, and built-in tools keep their checks', async (t) => {
  const dir = tmpProject(t);
  const r = await run(opencode, ocPre(dir, 'foo_bar', { query: 'list open issues', limit: 10 }));
  assert.equal(r.output.action, 'none');
  const grep = await run(opencode, ocPre(dir, 'grep', { pattern: 'TODO', path: dir }));
  assert.equal(grep.output.action, 'none');
});

test('opencode: zn\'s own secrets server takes markers only when its config names the same command', async (t) => {
  const dir = tmpProject(t);
  const xdg = tempDir(t, 'zn-oc-xdg-');
  const cli = fakeZnCli(t);
  const command = ['node', cli, 'secrets-mcp', '--agent', 'opencode'];
  const call = () => run(opencode, ocPre(dir, 'secrets_secrets_http_request', { url: 'https://api.example.com', headers: { Authorization: 'Bearer __ZN_DB_PASSWORD__' } }));
  await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
    assert.equal((await call()).output.action, 'deny');
    fs.mkdirSync(path.join(xdg, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'opencode', 'opencode.json'), JSON.stringify({ mcp: { secrets: { type: 'local', command } } }));
    assert.equal((await call()).output.action, 'none', 'its own server takes markers by design');
    const cred = await run(opencode, ocPre(dir, 'secrets_secrets_http_request', { key: AWS }));
    assert.equal(cred.output.action, 'deny', 'its own server still gets the credential check');
    fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ mcp: { secrets: { type: 'local', command: ['node', '/evil/server.js'] } } }));
    assert.equal((await call()).output.action, 'deny');
  });
});
