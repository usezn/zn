'use strict';

// zn-gate stats: these tests must never count into the real ~/.zn/stats.json.
process.env.ZN_STATS = 'off';

// Codex, Cursor and OpenCode adapters: event normalisation, responses within
// each agent's documented limits, install/uninstall, and the OpenCode plugin
// running against the real hook runner. Values are fake (fixtures generator).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const { getAdapter, listAdapters } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { generateAll } = require('./fixtures/fake_secrets');
const { tempDir } = require('./helpers/tmp');

const FAKE = generateAll(5150, { perType: 1, piiPerType: 1 });
const AWS = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;
const GHP = FAKE.secrets.find((s) => s.type === 'github_pat_classic').value;

const codex = getAdapter('codex');
const cursor = getAdapter('cursor');
const opencode = getAdapter('opencode');

function tmpProject(t) {
  const dir = tempDir(t, 'zn-agents-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=' + GHP + '\n');
  return dir;
}

function run(adapter, raw, extra = {}) {
  return runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --', ...extra });
}

test('registry lists the seven adapters', () => {
  assert.deepEqual(listAdapters().sort(), ['antigravity', 'claude-code', 'codex', 'copilot', 'cursor', 'gemini', 'opencode']);
});

/* ------------------------------- Codex ------------------------------- */

const cx = (event, extra) => ({ session_id: 's', transcript_path: '/t', cwd: extra.cwd || '/', hook_event_name: event, model: 'm', ...extra });

test('codex: credential reads are denied, markers get the zn run command, no auto-approval', async (t) => {
  const dir = tmpProject(t);
  const d1 = await run(codex, cx('PreToolUse', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'cat .env' } }));
  assert.equal(d1.output.hookSpecificOutput.permissionDecision, 'deny');
  const d2 = await run(codex, cx('PreToolUse', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'psql "postgres://a:__ZN_DB_PASSWORD__@h/d"' } }));
  assert.equal(d2.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d2.output.hookSpecificOutput.permissionDecisionReason, /zn run -- psql "postgres:\/\/a:__ZN_DB_PASSWORD__@h\/d"/);
  assert.equal(d2.output.hookSpecificOutput.updatedInput, undefined, 'never rewrites (would need allow)');
  // Already wrapped: no opinion, Codex's approval policy applies.
  const d3 = await run(codex, cx('PreToolUse', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'zn run -- psql "postgres://a:__ZN_DB_PASSWORD__@h/d"' } }));
  assert.equal(d3.output, null);
  const clean = await run(codex, cx('PreToolUse', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  assert.equal(clean.output, null, 'never emits allow');
  for (const r of [d1, d2, d3, clean]) assert.notEqual(r.output && r.output.hookSpecificOutput && r.output.hookSpecificOutput.permissionDecision, 'allow');
});

test('codex: apply_patch into ~/.zn is denied; patches are parsed', async () => {
  const home = os.homedir();
  const patch = '*** Begin Patch\n*** Add File: src/a.js\n+x\n*** Update File: ' + path.join(home, '.zn', 'vault', 'secrets.age') + '\n*** End Patch';
  assert.equal(codex.patchFiles(patch).length, 2);
  const r = await run(codex, cx('PreToolUse', { cwd: '/tmp', tool_name: 'apply_patch', tool_input: { command: patch } }));
  assert.equal(r.output.hookSpecificOutput.permissionDecision, 'deny');
});

test('codex: output with secrets is replaced through block; prompts with secrets are blocked', async () => {
  const p = await run(codex, cx('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'env' }, tool_response: { stdout: 'AWS=' + AWS, stderr: '' } }));
  assert.equal(p.output.decision, 'block');
  assert.ok(!p.output.reason.includes(AWS));
  assert.match(p.output.reason, /AWS=__ZN_AWS_KEY_1__/);
  const m = await run(codex, cx('PostToolUse', { tool_name: 'mcp__gh__get', tool_input: {}, tool_response: { content: [{ type: 'text', text: 'tok ' + GHP }] } }));
  assert.ok(!JSON.stringify(m.output).includes(GHP));
  const u = await run(codex, cx('UserPromptSubmit', { prompt: 'use ' + AWS }));
  assert.equal(u.output.decision, 'block');
  assert.ok(!u.output.reason.includes(AWS));
  assert.equal((await run(codex, cx('PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_response: { stdout: 'ok' } }))).output, null);
});

test('codex: install writes hooks.json (user and project) and uninstall removes only ours', (t) => {
  const home = tempDir(t, 'zn-cx-');
  const env = { CODEX_HOME: path.join(home, '.codex'), ZN_HOME: path.join(home, '.zn') };
  const file = codex.hooksFile({ env });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] } }));
  const rep = codex.install({ env, nodePath: '/usr/bin/node', runnerPath: '/x/lib/hooks/runner.js' });
  assert.ok(rep.backup);
  assert.ok(rep.warnings.some((w) => /\/hooks/.test(w)), 'tells the user to trust the hooks');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.hooks.PreToolUse.length, 2);
  assert.match(data.hooks.PreToolUse[1].hooks[0].command, /^'.*zn-hook-codex\.sh' PreToolUse$/);
  assert.ok(fs.readFileSync(path.join(home, '.zn', 'hooks', 'zn-hook-codex.sh'), 'utf8').includes("ZN_NODE='/usr/bin/node'"));
  assert.equal(data.hooks.PostToolUse[0].matcher, codex.POST_MATCHER);
  codex.install({ env, nodePath: '/usr/bin/node', runnerPath: '/x/lib/hooks/runner.js' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse.length, 2, 'idempotent');
  codex.uninstall({ env });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hooks, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] });
  const proj = tmpProject(t);
  codex.install({ scope: 'project', projectDir: proj });
  assert.ok(fs.existsSync(path.join(proj, '.codex', 'hooks.json')));
});

/* ------------------------------- Cursor ------------------------------ */

const cu = (event, extra) => ({ conversation_id: 'c', generation_id: 'g', hook_event_name: event, workspace_roots: [extra.cwd || '/'], ...extra });

test('cursor: beforeReadFile denies plain .env and credential files, allows others', async (t) => {
  const dir = tmpProject(t);
  const r1 = await run(cursor, cu('beforeReadFile', { cwd: dir, file_path: path.join(dir, '.env'), content: 'API_KEY=x' }));
  assert.deepEqual(Object.keys(r1.output).sort(), ['permission', 'user_message']);
  assert.equal(r1.output.permission, 'deny');
  const r2 = await run(cursor, cu('beforeReadFile', { cwd: dir, file_path: path.join(dir, 'src.js'), content: '' }));
  assert.deepEqual(r2.output, { permission: 'allow' });
});

test('cursor: shell commands: deny reads, zn run guidance for markers, ask once wrapped, silent otherwise', async (t) => {
  const dir = tmpProject(t);
  const a = await run(cursor, cu('beforeShellExecution', { cwd: dir, command: 'grep KEY .env', sandbox: false }));
  assert.equal(a.output.permission, 'deny');
  const b = await run(cursor, cu('beforeShellExecution', { cwd: dir, command: 'gh api -H "Authorization: token __ZN_GITHUB_TOKEN__" /user' }));
  assert.equal(b.output.permission, 'deny');
  assert.match(b.output.agent_message, /zn run -- gh api/);
  const c = await run(cursor, cu('beforeShellExecution', { cwd: dir, command: 'zn run -- gh api -H "Authorization: token __ZN_GITHUB_TOKEN__" /user' }));
  assert.equal(c.output.permission, 'ask');
  assert.equal((await run(cursor, cu('beforeShellExecution', { cwd: dir, command: 'ls' }))).output, null, 'no auto-approval');
});

test('cursor: MCP output is tokenized, built-in output cannot be, prompts with secrets are blocked', async () => {
  const m = await run(cursor, cu('postToolUse', { tool_name: 'MCP:get_issue', tool_input: {}, tool_output: JSON.stringify({ content: [{ type: 'text', text: 'key ' + AWS }] }) }));
  assert.ok(!JSON.stringify(m.output).includes(AWS));
  assert.match(JSON.stringify(m.output.updated_mcp_tool_output), /__ZN_AWS_KEY_1__/);
  const s = await run(cursor, cu('postToolUse', { tool_name: 'Shell', tool_input: { command: 'env' }, tool_output: JSON.stringify({ stdout: AWS }) }));
  assert.equal(s.output, null, 'documented limit: Cursor cannot rewrite shell output');
  const p = await run(cursor, cu('beforeSubmitPrompt', { prompt: 'deploy with ' + GHP }));
  assert.equal(p.output.continue, false);
  assert.ok(!p.output.user_message.includes(GHP));
  assert.deepEqual((await run(cursor, cu('beforeSubmitPrompt', { prompt: 'hello' }))).output, { continue: true });
});

test('cursor: install writes version 1 hooks.json with our events', (t) => {
  const home = tempDir(t, 'zn-cu-');
  // platform is explicit: on Windows the default is the PowerShell form (below).
  cursor.install({ home, nodePath: '/usr/bin/node', runnerPath: '/x/lib/hooks/runner.js', platform: 'linux' });
  const data = JSON.parse(fs.readFileSync(cursor.hooksFile({ home }), 'utf8'));
  assert.equal(data.version, 1);
  assert.deepEqual(Object.keys(data.hooks).sort(), [...cursor.EVENTS].sort());
  assert.equal(data.hooks.beforeReadFile[0].command, "'/usr/bin/node' '/x/lib/hooks/runner.js' cursor");
  cursor.uninstall({ home });
  assert.deepEqual(JSON.parse(fs.readFileSync(cursor.hooksFile({ home }), 'utf8')).hooks, {});
});

test('cursor: install on Windows wraps the hook command in powershell.exe', (t) => {
  const home = tempDir(t, 'zn-cu-win-');
  cursor.install({ home, nodePath: '/usr/bin/node', runnerPath: '/x/lib/hooks/runner.js', platform: 'win32' });
  const data = JSON.parse(fs.readFileSync(cursor.hooksFile({ home }), 'utf8'));
  const expected = 'powershell.exe -NoProfile -NonInteractive -Command "& \'/usr/bin/node\' \'/x/lib/hooks/runner.js\' cursor"';
  assert.equal(data.hooks.beforeReadFile[0].command, expected);
  assert.equal(data.hooks.beforeMCPExecution[0].command, expected);
  cursor.uninstall({ home, platform: 'win32' });
  assert.deepEqual(JSON.parse(fs.readFileSync(cursor.hooksFile({ home }), 'utf8')).hooks, {});
});

const FAKE_AWS_KEY = 'AKIA' + 'Z'.repeat(16); // built at runtime, never a literal

test('cursor: beforeMCPExecution is installed without failClosed', (t) => {
  const home = tempDir(t, 'zn-cu-mcp-');
  cursor.install({ home, nodePath: '/usr/bin/node', runnerPath: '/x/lib/hooks/runner.js', platform: 'linux' });
  const data = JSON.parse(fs.readFileSync(cursor.hooksFile({ home }), 'utf8'));
  const entry = data.hooks.beforeMCPExecution[0];
  assert.equal(entry.command, "'/usr/bin/node' '/x/lib/hooks/runner.js' cursor");
  assert.equal(entry.timeout, 30);
  assert.equal(entry.failClosed, undefined, 'no failClosed: an empty answer would block every MCP call');
  cursor.uninstall({ home });
});

test('cursor: beforeMCPExecution normalizes; only a deny gets an answer', (t) => {
  const dir = tmpProject(t);
  const ev = cursor.normalize(cu('beforeMCPExecution', { cwd: dir, tool_name: 'query', mcp_server_name: 'db', tool_input: '{"sql":"select 1"}' }));
  assert.equal(ev.event, 'pre_tool');
  assert.equal(ev.tool, 'mcp');
  assert.deepEqual(ev.mcp, { server: 'db', tool: 'query' });
  assert.deepEqual(ev.input.args, { sql: 'select 1' }, 'a JSON string tool_input is parsed');
  assert.deepEqual(cursor.respond({ decision: 'deny', message: 'no', event: ev }), { permission: 'deny', user_message: 'no', agent_message: 'no' });
  assert.equal(cursor.respond({ decision: 'allow', event: ev }), null);
});

test('cursor: MCP arguments with a secret value are denied by kind, the value is never printed', async (t) => {
  const dir = tmpProject(t);
  const r = await run(cursor, cu('beforeMCPExecution', { cwd: dir, tool_name: 'create_issue', mcp_server_name: 'github', tool_input: { body: 'key ' + FAKE_AWS_KEY } }));
  assert.equal(r.output.permission, 'deny');
  assert.match(r.output.agent_message, /AWS key/);
  assert.match(r.output.agent_message, /the MCP server github/);
  assert.ok(!JSON.stringify(r.output).includes(FAKE_AWS_KEY));
  const asString = await run(cursor, cu('beforeMCPExecution', { cwd: dir, tool_name: 'create_issue', mcp_server_name: 'github', tool_input: JSON.stringify({ body: FAKE_AWS_KEY }) }));
  assert.equal(asString.output.permission, 'deny', 'tool_input as a JSON string is checked too');
  assert.ok(!JSON.stringify(asString.output).includes(FAKE_AWS_KEY));
});

// The command `zn hooks install` writes for the secrets server, under a fake
// zn-gate install outside the project (the strict matcher checks the real file).
function fakeZnSecretsCommand(t) {
  const pkg = path.join(tempDir(t, 'zn-install-'), 'zn-gate');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'zn-gate' }));
  const cli = path.join(pkg, 'bin', 'cli.js');
  fs.writeFileSync(cli, '// test double\n');
  return 'node ' + cli + ' secrets-mcp --agent cursor';
}

test('cursor: a __ZN_ marker goes to no server but zn\'s own "secrets" server', async (t) => {
  const dir = tmpProject(t);
  const command = fakeZnSecretsCommand(t);
  const other = await run(cursor, cu('beforeMCPExecution', { cwd: dir, tool_name: 'query', mcp_server_name: 'postgres', tool_input: { password: '__ZN_DB_PASSWORD__' } }));
  assert.equal(other.output.permission, 'deny');
  assert.match(other.output.user_message, /secrets_http_request/);
  const own = await run(cursor, cu('beforeMCPExecution', { cwd: dir, tool_name: 'secrets_http_request', mcp_server_name: 'secrets', command, tool_input: { url: 'https://api.example.com', token: '__ZN_DB_PASSWORD__' } }));
  assert.equal(own.output, null);
  // Our server still gets the credential check: markers are its job, raw values are not.
  const ownCred = await run(cursor, cu('beforeMCPExecution', { cwd: dir, tool_name: 'secrets_http_request', mcp_server_name: 'secrets', command, tool_input: { key: FAKE_AWS_KEY } }));
  assert.equal(ownCred.output.permission, 'deny');
  assert.ok(!JSON.stringify(ownCred.output).includes(FAKE_AWS_KEY));
});

test('cursor: a "secrets" server is ours only when it is zn\'s own install', async (t) => {
  const dir = tmpProject(t);
  // Same name and words, but not a zn-gate install: a repository can ship this.
  const spoof = await run(cursor, cu('beforeMCPExecution', { cwd: dir, tool_name: 'x', mcp_server_name: 'secrets', command: 'node /opt/evil/evil.js secrets-mcp', tool_input: { key: FAKE_AWS_KEY } }));
  assert.equal(spoof.output.permission, 'deny');
  assert.ok(!JSON.stringify(spoof.output).includes(FAKE_AWS_KEY));
  const spoofMarker = await run(cursor, cu('beforeMCPExecution', { cwd: dir, tool_name: 'x', mcp_server_name: 'secrets', command: 'node /opt/evil/evil.js secrets-mcp', tool_input: { token: '__ZN_DB_PASSWORD__' } }));
  assert.equal(spoofMarker.output.permission, 'deny');
  // A server reached by URL is never ours, whatever its name.
  const url = await run(cursor, cu('beforeMCPExecution', { cwd: dir, tool_name: 'x', mcp_server_name: 'secrets', url: 'https://evil.example/mcp', tool_input: { token: '__ZN_DB_PASSWORD__' } }));
  assert.equal(url.output.permission, 'deny');
  // A name alone (no command) is not enough: markers are refused, as for any other server.
  const nameOnly = await run(cursor, cu('beforeMCPExecution', { cwd: dir, tool_name: 'x', mcp_server_name: 'secrets', tool_input: { token: '__ZN_DB_PASSWORD__' } }));
  assert.equal(nameOnly.output.permission, 'deny');
});

test('cursor: MCP calls from Claude Code and OpenCode are allowed without the engine or the vault', async (t) => {
  const dir = tmpProject(t);
  // An engine that throws: any scan or prepare would make the call fail closed (deny).
  const boom = { scan() { throw new Error('engine used'); }, async prepare() { throw new Error('engine used'); } };
  const claudeCode = getAdapter('claude-code');
  const cc = await run(claudeCode, cx('PreToolUse', { cwd: dir, tool_name: 'mcp__github__get_issue', tool_input: { number: 1 } }), { engine: boom });
  assert.equal(cc.decision.decision, 'allow');
  const oc = await run(opencode, { hook: 'tool.execute.before', tool: 'github_get_file', cwd: dir, args: { path: 'README.md' } }, { engine: boom });
  assert.equal(oc.decision.decision, 'allow');
});

test('cursor: benign MCP calls get no answer; large arguments are scanned in full, up to 1 MB', async (t) => {
  const dir = tmpProject(t);
  assert.equal((await run(cursor, cu('beforeMCPExecution', { cwd: dir, tool_name: 'list', mcp_server_name: 'github', tool_input: { repo: 'usezn/zn' } }))).output, null);
  const benign = await run(cursor, cu('beforeMCPExecution', { cwd: dir, tool_name: 'put', mcp_server_name: 'files', tool_input: { text: 'a'.repeat(500 * 1024) } }));
  assert.equal(benign.output, null);
  // A credential deep inside a large argument is still found (the scan is windowed).
  const deep = await run(cursor, cu('beforeMCPExecution', { cwd: dir, tool_name: 'put', mcp_server_name: 'files', tool_input: { text: 'a'.repeat(300 * 1024) + ' ' + FAKE_AWS_KEY + ' ' + 'b'.repeat(300 * 1024) } }));
  assert.equal(deep.output.permission, 'deny');
  assert.ok(!JSON.stringify(deep.output).includes(FAKE_AWS_KEY));
  const big = await run(cursor, cu('beforeMCPExecution', { cwd: dir, tool_name: 'put', mcp_server_name: 'files', tool_input: { text: 'a'.repeat(1024 * 1024) } }));
  assert.equal(big.output.permission, 'deny');
  assert.match(big.output.agent_message, /too large for zn to check/);
});

/* ------------------------------ OpenCode ----------------------------- */

test('opencode: before/after/chat events map to runner decisions', async (t) => {
  const dir = tmpProject(t);
  const deny = await run(opencode, { hook: 'tool.execute.before', tool: 'read', cwd: dir, args: { filePath: path.join(dir, '.env') } });
  assert.equal(deny.output.action, 'deny');
  const wrap = await run(opencode, { hook: 'tool.execute.before', tool: 'bash', cwd: dir, args: { command: 'psql __ZN_DB_PASSWORD__', description: 'd' } });
  assert.equal(wrap.output.action, 'args');
  assert.match(wrap.output.args.command, /run\.js" -- psql __ZN_DB_PASSWORD__$/);
  const after = await run(opencode, { hook: 'tool.execute.after', tool: 'bash', cwd: dir, args: {}, output: 'AWS=' + AWS });
  assert.equal(after.output.action, 'output');
  assert.ok(!after.output.output.includes(AWS));
  const mcp = await run(opencode, { hook: 'tool.execute.after', tool: 'github_get_file', cwd: dir, args: {}, content: [{ type: 'text', text: GHP }] });
  assert.ok(!JSON.stringify(mcp.output).includes(GHP));
  const chat = await run(opencode, { hook: 'chat.message', cwd: dir, prompt: 'token ' + GHP });
  assert.equal(chat.output.action, 'deny');
  assert.deepEqual((await run(opencode, { hook: 'tool.execute.before', tool: 'bash', cwd: dir, args: { command: 'ls' } })).output, { action: 'none' });
});

test('opencode: the installed plugin, driven like OpenCode does, blocks, rewrites in place and scrubs', async (t) => {
  const dir = tmpProject(t);
  const xdg = tempDir(t, 'zn-oc-');
  const znHome = tempDir(t, 'zn-oc-home-');
  const env = { XDG_CONFIG_HOME: xdg };
  const rep = opencode.install({ env });
  assert.ok(rep.settings.endsWith(path.join('opencode', 'plugins', 'zn-gate.js')));
  const saved = process.env.ZN_HOME;
  const savedShell = process.env.SHELL;
  process.env.SHELL = 'bash'; // the plugin reads it at load; Windows runners have none, which means PowerShell
  process.env.ZN_HOME = znHome; // vault locked: the real engine redacts irreversibly
  try {
    // OpenCode loads the plugin as an ES module; Node 18 needs the .mjs extension for that.
    const mjs = rep.settings.replace(/\.js$/, '.under-test.mjs');
    fs.copyFileSync(rep.settings, mjs);
    const mod = await import(pathToFileURL(mjs).href);
    fs.unlinkSync(mjs);
    const hooks = await mod.ZnGate({ directory: dir });
    await assert.rejects(hooks['tool.execute.before']({ tool: 'read', sessionID: 's', callID: 'c' }, { args: { filePath: path.join(dir, '.env') } }), /env shadow/);
    const args = { command: 'psql __ZN_DB_PASSWORD__', description: 'x' };
    const out1 = { args };
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, out1);
    assert.equal(out1.args, args, 'mutated in place, not replaced');
    assert.match(args.command, /run\.js' -- psql __ZN_DB_PASSWORD__$/);
    assert.equal(args.description, 'x');
    const res = { title: 't', output: 'line\nAWS_ACCESS_KEY_ID=' + AWS + '\n', metadata: { preview: 'AWS_ACCESS_KEY_ID=' + AWS, display: { type: 'file', text: AWS }, truncated: false } };
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: 's', callID: 'c', args: {} }, res);
    assert.ok(!res.output.includes(AWS));
    assert.match(res.output, /__ZN_REDACTED_AWS_KEY__/);
    assert.ok(!JSON.stringify(res.metadata).includes(AWS), 'metadata (TUI preview) scrubbed too');
    assert.equal(res.metadata.truncated, false);
    const mcpRes = { content: [{ type: 'text', text: 'tok ' + GHP }, { type: 'image', data: 'x' }] };
    await hooks['tool.execute.after']({ tool: 'gh_get', sessionID: 's', callID: 'c', args: {} }, mcpRes);
    assert.ok(!mcpRes.content[0].text.includes(GHP));
    assert.equal(mcpRes.content[1].data, 'x');
    await assert.rejects(hooks['chat.message']({ sessionID: 's' }, { message: {}, parts: [{ type: 'text', text: 'here ' + GHP }] }), /secret set/);
    await hooks['chat.message']({ sessionID: 's' }, { message: {}, parts: [{ type: 'text', text: 'hello' }] });
  } finally {
    if (saved === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = saved;
    if (savedShell === undefined) delete process.env.SHELL; else process.env.SHELL = savedShell;
  }
  opencode.uninstall({ env });
  assert.ok(!fs.existsSync(rep.settings));
});

test('opencode: install refuses to overwrite a plugin it did not write', (t) => {
  const xdg = tempDir(t, 'zn-oc2-');
  const file = opencode.pluginPath({ env: { XDG_CONFIG_HOME: xdg } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'export const Mine = async () => ({})\n');
  assert.throws(() => opencode.install({ env: { XDG_CONFIG_HOME: xdg } }), /not written by zn/);
});

test('opencode: with PowerShell as the shell, a marker command is wrapped in PowerShell form', async (t) => {
  const dir = tmpProject(t);
  const opts = { nodePath: String.raw`C:\Program Files\nodejs\node.exe`, runJs: String.raw`C:\Users\ana\zn\run.js` };
  for (const shell of ['pwsh', 'pwsh.exe', 'powershell.exe', String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`]) {
    const r = await run(opencode, { hook: 'tool.execute.before', tool: 'bash', shell, cwd: dir, args: { command: "psql 'postgres://app:__ZN_DB_PASSWORD__@db.example.test/app' -c 'select 1'" } }, opts);
    assert.equal(r.output.action, 'args', shell);
    const c = r.output.args.command;
    assert.match(c, /^& '[^']*node(\.exe)?' '[^']*run\.js' --agent opencode -- psql 'postgres:\/\/app:__ZN_DB_PASSWORD__@db\.example\.test\/app' -c 'select 1'$/, shell);
    assert.doesNotMatch(c, /ZN_AGENT=|cmd(\.exe)?\s|\/c /);
    assert.ok(c.includes('Program Files'), 'a path with a space stays in one quoted word');
  }
  // A path with a single quote is doubled inside PowerShell single quotes.
  const q = await run(opencode, { hook: 'tool.execute.before', tool: 'bash', shell: 'pwsh', cwd: dir, args: { command: 'psql __ZN_DB_PASSWORD__' } }, { nodePath: String.raw`C:\Users\o'brien\node.exe`, runJs: String.raw`C:\x\run.js` });
  // Windows paths come out with forward slashes on Windows and as given elsewhere; the quoting is the same.
  const bs = String.fromCharCode(92);
  assert.ok(q.output.args.command.split(bs).join('/').startsWith("& 'C:/Users/o''brien/node.exe' "));
  assert.match(q.output.args.command, / --agent opencode -- psql __ZN_DB_PASSWORD__$/);
  // Already wrapped, or no marker: left alone.
  const none = await run(opencode, { hook: 'tool.execute.before', tool: 'bash', shell: 'pwsh', cwd: dir, args: { command: 'Get-ChildItem' } }, opts);
  assert.deepEqual(none.output, { action: 'none' });
  // Not one plain native command: refused, never run with a placeholder.
  for (const command of ['Get-Content x | psql __ZN_DB_PASSWORD__', 'Invoke-WebRequest __ZN_API_KEY__', 'psql $env:X __ZN_DB_PASSWORD__']) {
    const d = await run(opencode, { hook: 'tool.execute.before', tool: 'bash', shell: 'pwsh', cwd: dir, args: { command } }, opts);
    assert.equal(d.output.action, 'deny', command);
    assert.match(d.output.message, /PowerShell/);
  }
});

test('opencode: bash and unknown shells keep the bash wrapping', async (t) => {
  const dir = tmpProject(t);
  for (const shell of [undefined, '', 'bash', '/usr/bin/zsh', 'sh', 'fish', 'nushell']) {
    const r = await run(opencode, { hook: 'tool.execute.before', tool: 'bash', shell, cwd: dir, args: { command: 'psql __ZN_DB_PASSWORD__' } });
    assert.equal(r.output.action, 'args', String(shell));
    assert.match(r.output.args.command, /^ZN_AGENT=x "node" "run\.js" -- psql __ZN_DB_PASSWORD__$/, String(shell));
  }
  assert.equal(opencode.isPowerShellName('pwsh-preview'), true);
  assert.equal(opencode.isPowerShellName('powershell-core'), false);
});

test('opencode: on Windows an unset or non-bash SHELL means PowerShell, a bash SHELL keeps bash', async (t) => {
  const dir = tmpProject(t);
  const opts = { nodePath: String.raw`C:\node.exe`, runJs: String.raw`C:\x\run.js` };
  const call = (shell, platform) => run(opencode, { hook: 'tool.execute.before', tool: 'bash', shell, platform, cwd: dir, args: { command: 'psql __ZN_DB_PASSWORD__' } }, opts);
  for (const shell of [undefined, '', 'cmd', 'fish']) {
    const r = await call(shell, 'win32');
    assert.equal(r.output.action, 'args', String(shell));
    assert.match(r.output.args.command, /^&\s/, String(shell));
  }
  for (const shell of ['bash', 'bash.exe', 'sh.exe', 'zsh']) {
    const r = await call(shell, 'win32');
    assert.match(r.output.args.command, /^ZN_AGENT=x /, String(shell));
  }
  for (const shell of [undefined, '', 'bash']) {
    const r = await call(shell, 'linux');
    assert.match(r.output.args.command, /^ZN_AGENT=x /, String(shell));
  }
  assert.equal(opencode.usesPowerShell('', 'win32'), true);
  assert.equal(opencode.usesPowerShell('', 'darwin'), false);
});

test('opencode plugin: sends only the name of the shell, not its path', () => {
  const src = opencode.pluginSource({ scope: 'user', nodePath: '/usr/bin/node', runnerPath: '/opt/zn/lib/hooks/runner.js' });
  assert.match(src, /process\.env\.SHELL/);
  assert.match(src, /\.split\("\/"\)\.pop\(\)/);
  assert.match(src, /args: output\.args, shell: SHELL, platform: process\.platform/);
  // The generated plugin is valid JavaScript.
  assert.doesNotThrow(() => new (require('vm').Script)(src.replace(/^import .*$/m, '').replace(/^export const/m, 'const')));
});

test('opencode project plugin: cmd.exe does not look for zn in the project directory first', () => {
  const src = require('../lib/agents/opencode').pluginSource({ scope: 'project' });
  const call = src.match(/spawn\(NODE,[^\n]*\)/)[0];
  assert.match(call, /NoDefaultCurrentDirectoryInExePath: "1"/);
  const user = require('../lib/agents/opencode').pluginSource({ scope: 'user', nodePath: '/usr/bin/node', runnerPath: '/opt/zn/lib/hooks/runner.js' });
  assert.match(user.match(/spawn\(NODE,[^\n]*\)/)[0], /shell: false/);
});

/* 1.8.0 review: the MCP size notice does not suggest splitting the content. */
test('cursor: the MCP size notice tells the agent to tell the user, not to resend in parts', async (t) => {
  const dir = tmpProject(t);
  const big = await run(cursor, cu('beforeMCPExecution', { cwd: dir, tool_name: 'put', mcp_server_name: 'files', tool_input: { text: 'a'.repeat(1024 * 1024) } }));
  assert.equal(big.output.permission, 'deny');
  assert.match(big.output.agent_message, /Next step: tell the user; do not resend this content in parts\./);
  assert.doesNotMatch(big.output.agent_message, /split|smaller calls/);
});

// --help / -h on every subcommand prints its usage and exits 0 (no "needs a value").
test('--help and -h print the usage for hooks, secret, env and team subcommands', () => {
  const { spawnSync } = require('child_process');
  const cli = require('path').join(__dirname, '..', 'bin', 'cli.js');
  const cases = [
    [['hooks', 'install', '--help'], /usage: zn hooks install\|uninstall/],
    [['hooks', 'uninstall', '-h'], /usage: zn hooks install\|uninstall/],
    [['hooks', 'install', 'codex', '--project', '--help'], /--no-mcp/],
    [['secret', 'set', '--help'], /usage: zn secret/],
    [['secret', 'allow', '-h'], /usage: zn secret/],
    [['env', 'shadow', '--help'], /usage: zn env shadow/],
    [['env', 'unshadow', '-h'], /usage: zn env shadow/],
    [['env', 'unshadow', 'F', '--backup', '--help'], /usage: zn env shadow/],
    [['team', '--help'], /usage: zn team join/],
  ];
  for (const [args, re] of cases) {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ZN_LOCAL_ONLY: 'true' } });
    assert.strictEqual(r.status, 0, args.join(' ') + ': ' + r.stderr);
    assert.match(r.stdout, re, args.join(' '));
    assert.doesNotMatch(r.stderr + r.stdout, /needs a value/);
  }
  // A lone `--` stops help detection: the usage is not printed and the invalid-name error code is kept.
  const r = spawnSync(process.execPath, [cli, 'secret', 'set', '--', '--help'], { encoding: 'utf8', env: { ...process.env, ZN_LOCAL_ONLY: 'true' } });
  assert.doesNotMatch(r.stdout, /usage: zn secret/);
  assert.strictEqual(r.status, 64, r.stderr);
});
