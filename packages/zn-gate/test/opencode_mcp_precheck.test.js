'use strict';

process.env.ZN_STATS = 'off';

// OpenCode: the arguments of MCP tool calls are checked before the call runs, as for Claude Code and Cursor.
// The "secrets" server of zn itself (found in OpenCode's configuration) is the only one that may carry markers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runner = require('../lib/hooks/runner');
const { getAdapter } = require('../lib/agents');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { generateAll } = require('./fixtures/fake_secrets');
const { tempDir } = require('./helpers/tmp');

const FAKE = generateAll(5150, { perType: 1, piiPerType: 1 });
const AWS = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;
const MARKER = '__ZN_DB_PASSWORD__';
const opencode = getAdapter('opencode');

// A project folder with its own (empty) user config home, so nothing of the machine's real OpenCode setup counts.
function setup(t, config) {
  const dir = tempDir(t, 'zn-ocmcp-');
  const home = path.join(dir, 'xdg');
  fs.mkdirSync(home);
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  if (config !== undefined) fs.writeFileSync(path.join(project, 'opencode.json'), typeof config === 'string' ? config : JSON.stringify(config));
  const names = ['XDG_CONFIG_HOME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR'];
  const saved = {};
  for (const k of names) saved[k] = process.env[k];
  process.env.XDG_CONFIG_HOME = home;
  delete process.env.OPENCODE_CONFIG;
  delete process.env.OPENCODE_CONFIG_CONTENT;
  delete process.env.OPENCODE_CONFIG_DIR;
  t.after(() => { for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  return project;
}

function call(project, tool, args, extra = {}) {
  const raw = { hook: 'tool.execute.before', tool, cwd: project, args };
  return runner.handle(opencode, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --', ...extra });
}

const OURS = { type: 'local', command: ['zn', 'secrets-mcp', '--agent', 'opencode'] };
const THIRD = { type: 'local', command: ['npx', 'x'] };

test('opencode mcp: a marker in a third-party MCP call is denied', async (t) => {
  const project = setup(t, { mcp: { github: THIRD } });
  const r = await call(project, 'github_create_issue', { title: 'x', body: MARKER });
  assert.equal(r.output.action, 'deny');
  // Also when the server is not in any configuration.
  const r2 = await call(setup(t), 'other_put', { token: MARKER });
  assert.equal(r2.output.action, 'deny');
});

test('opencode mcp: a secret value in a third-party MCP call is denied and not echoed', async (t) => {
  const project = setup(t, { mcp: { github: THIRD } });
  const r = await call(project, 'github_create_issue', { body: 'key ' + AWS });
  assert.equal(r.output.action, 'deny');
  assert.ok(!JSON.stringify(r.output).includes(AWS));
});

test('opencode mcp: a benign MCP call is allowed', async (t) => {
  const project = setup(t, { mcp: { github: THIRD } });
  const r = await call(project, 'github_get_file', { path: 'README.md' });
  assert.equal(r.decision.decision, 'allow');
});

test('opencode mcp: a call to the secrets server of zn itself (found in opencode.json) may carry a marker', async (t) => {
  const project = setup(t, { mcp: { secrets: OURS } });
  const r = await call(project, 'secrets_secrets_http_request', { url: 'https://example.com', headers: { Authorization: 'Bearer ' + MARKER } });
  assert.notEqual(r.decision.decision, 'deny');
  const r2 = await call(project, 'secrets_secrets_render_file', { template: MARKER });
  assert.notEqual(r2.decision.decision, 'deny');
  // A tool that is not one of the server's own does not count, even with the same server prefix.
  const r3 = await call(project, 'secrets_other_tool', { token: MARKER });
  assert.equal(r3.output.action, 'deny');
});

test('opencode mcp: a server named like the one of zn with another command is denied', async (t) => {
  const project = setup(t, { mcp: { secrets: { type: 'local', command: ['node', '/opt/evil/evil.js', 'secrets-mcp'] } } });
  const r = await call(project, 'secrets_secrets_http_request', { token: MARKER });
  assert.equal(r.output.action, 'deny');
  const remote = setup(t, { mcp: { secrets: { type: 'remote', url: 'https://evil.example/mcp' } } });
  assert.equal((await call(remote, 'secrets_secrets_http_request', { token: MARKER })).output.action, 'deny');
});

test('opencode mcp: a second definition of the name that is not the one of zn makes it not ours', async (t) => {
  const project = setup(t, { mcp: { secrets: OURS } });
  fs.mkdirSync(path.join(project, '.opencode'));
  fs.writeFileSync(path.join(project, '.opencode', 'opencode.json'), JSON.stringify({ mcp: { secrets: { type: 'local', command: ['node', 'evil.js'] } } }));
  assert.equal((await call(project, 'secrets_secrets_http_request', { token: MARKER })).output.action, 'deny');
});

test('opencode mcp: an unreadable configuration is treated as not ours', async (t) => {
  const project = setup(t, '{ this is not json');
  assert.equal((await call(project, 'secrets_secrets_http_request', { token: MARKER })).output.action, 'deny');
  // No configuration at all: nothing says the server is the one of zn.
  assert.equal((await call(setup(t), 'secrets_secrets_http_request', { token: MARKER })).output.action, 'deny');
});

test('opencode mcp: the server is the longest configured name that prefixes the tool name', (t) => {
  const project = setup(t, { mcp: { secrets: OURS, secrets_x: THIRD } });
  const ev = opencode.normalize({ hook: 'tool.execute.before', tool: 'secrets_x_secrets_list', cwd: project, args: {} });
  assert.equal(ev.mcp.server, 'secrets_x');
  assert.equal(ev.mcp.tool, 'secrets_list');
  assert.equal(ev.mcp.ours, undefined);
  const ours = opencode.normalize({ hook: 'tool.execute.before', tool: 'secrets_secrets_list', cwd: project, args: {} });
  assert.equal(ours.mcp.ours, 'secrets');
  assert.deepEqual(ours.input.args, {});
});

test('opencode mcp: local built-ins that only return text skip the MCP check; search queries do not', async (t) => {
  const boom = { scan() { throw new Error('engine used'); }, async prepare() { throw new Error('engine used'); } };
  const project = setup(t);
  for (const name of ['task', 'glob', 'list', 'skill']) {
    const ev = opencode.normalize({ hook: 'tool.execute.before', tool: name, cwd: project, args: { query: 'x' } });
    assert.equal(ev.input.args, undefined, name);
    assert.equal(ev.mcp, undefined, name);
  }
  const r = await call(project, 'task', { prompt: 'zn' }, { engine: boom });
  assert.equal(r.decision.decision, 'allow');
  // websearch and codesearch send their query to a search service: checked, never treated as zn's own server.
  for (const name of ['websearch', 'codesearch']) {
    const ev = opencode.normalize({ hook: 'tool.execute.before', tool: name, cwd: project, args: { query: 'x' } });
    assert.deepEqual(ev.input.args, { query: 'x' }, name);
    assert.equal(ev.mcp, undefined, name);
    const key = await call(project, name, { query: 'why does ' + AWS + ' fail' });
    assert.equal(key.output.action, 'deny', name + ' secret');
    assert.ok(!JSON.stringify(key.output).includes(AWS), name + ' not echoed');
    const marker = await call(project, name, { query: 'use ' + MARKER });
    assert.equal(marker.output.action, 'deny', name + ' marker');
    const plain = await call(project, name, { query: 'how to rotate an access key' });
    assert.equal(plain.decision.decision, 'allow', name + ' plain');
  }
  // A real MCP call does use the engine (it fails closed here).
  const mcp = await call(project, 'github_get_file', { path: 'a' }, { engine: boom });
  assert.equal(mcp.decision.decision, 'deny');
});

test('opencode mcp: only config files up to the git root count; one above it does not make the server ours', async (t) => {
  const dir = tempDir(t, 'zn-ocmcp-git-');
  const home = path.join(dir, 'xdg');
  fs.mkdirSync(home);
  const outer = path.join(dir, 'outer');
  const repo = path.join(outer, 'repo');
  const sub = path.join(repo, 'pkg');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'));
  const names = ['XDG_CONFIG_HOME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR'];
  const saved = {};
  for (const k of names) saved[k] = process.env[k];
  process.env.XDG_CONFIG_HOME = home;
  delete process.env.OPENCODE_CONFIG;
  delete process.env.OPENCODE_CONFIG_CONTENT;
  delete process.env.OPENCODE_CONFIG_DIR;
  t.after(() => { for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const tool = 'secrets_secrets_http_request';
  // Above the git root: not read.
  fs.writeFileSync(path.join(outer, 'opencode.json'), JSON.stringify({ mcp: { secrets: OURS } }));
  assert.equal((await call(sub, tool, { token: MARKER })).output.action, 'deny');
  // At the git root: read, from a subfolder of the repository.
  fs.writeFileSync(path.join(repo, 'opencode.json'), JSON.stringify({ mcp: { secrets: OURS } }));
  assert.notEqual((await call(sub, tool, { token: MARKER })).decision.decision, 'deny');
  // Without any .git above, only the working folder is read.
  const loose = path.join(dir, 'loose');
  const looseSub = path.join(loose, 'a');
  fs.mkdirSync(looseSub, { recursive: true });
  fs.writeFileSync(path.join(loose, 'opencode.json'), JSON.stringify({ mcp: { secrets: OURS } }));
  assert.equal((await call(looseSub, tool, { token: MARKER })).output.action, 'deny');
  assert.notEqual((await call(loose, tool, { token: MARKER })).decision.decision, 'deny');
});

test('opencode mcp: personal data in a third-party call follows the egress setting', async (t) => {
  const project = setup(t, { mcp: { github: THIRD } });
  const pii = { scan: (text) => { const i = String(text).indexOf('jane@example.com'); return i < 0 ? [] : [{ start: i, end: i + 16, type: 'EMAIL', source: 'pii' }]; }, async prepare(ctx) { return ctx; } };
  const args = { body: 'write to jane@example.com' };
  // Default: zn would ask; OpenCode cannot ask, so the call is denied with the reason.
  const ask = await call(project, 'github_create_issue', args, { engine: pii, egressCheck: 'ask' });
  assert.equal(ask.output.action, 'deny');
  assert.match(ask.output.message, /personal data/);
  // With the egress check off, nobody is asked and the call goes through.
  const off = await call(project, 'github_create_issue', args, { engine: pii, egressCheck: 'off' });
  assert.equal(off.decision.decision, 'allow');
});
