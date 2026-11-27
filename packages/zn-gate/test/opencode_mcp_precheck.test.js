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

const ORIG_CWD = process.cwd();
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
  // The hook runs in the project, never in the folder of the zn-gate that is installed.
  process.chdir(project);
  t.after(() => { process.chdir(ORIG_CWD); for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  return project;
}

function call(project, tool, args, extra = {}) {
  const raw = { hook: 'tool.execute.before', tool, cwd: project, args };
  return runner.handle(opencode, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --', ...extra });
}

const OWN_CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
// The server `zn hooks install opencode` suggests: this Node.js and this zn-gate's bin/cli.js.
const OURS = { type: 'local', command: [process.execPath, OWN_CLI, 'secrets-mcp', '--agent', 'opencode'] };

// Write opencode.json of the user-level config home (XDG_CONFIG_HOME/opencode) of setup().
function userConfig(config) {
  const dir = path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify(config));
}
const TOOL = 'secrets_secrets_http_request';
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

test('opencode mcp: a call to the secrets server of zn itself (found in the user-level opencode.json) may carry a marker', async (t) => {
  const project = setup(t);
  userConfig({ mcp: { secrets: OURS } });
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
  const project = setup(t);
  userConfig({ mcp: { secrets: OURS } });
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
  const project = setup(t, { mcp: { secrets_x: THIRD } });
  userConfig({ mcp: { secrets: OURS } });
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
  process.chdir(dir);
  t.after(() => { process.chdir(ORIG_CWD); for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const tool = 'secrets_secrets_http_request';
  // Above the git root: not read.
  fs.writeFileSync(path.join(outer, 'opencode.json'), JSON.stringify({ mcp: { secrets: OURS } }));
  assert.equal((await call(sub, tool, { token: MARKER })).output.action, 'deny');
  // At the git root: read, from a subfolder of the repository, but a project file never makes the server ours.
  fs.writeFileSync(path.join(repo, 'opencode.json'), JSON.stringify({ mcp: { secrets: OURS } }));
  assert.equal((await call(sub, tool, { token: MARKER })).output.action, 'deny');
  // A project file that defines the name also spoils the entry of the user config.
  userConfig({ mcp: { secrets: OURS } });
  assert.equal((await call(sub, tool, { token: MARKER })).output.action, 'deny');
  fs.unlinkSync(path.join(repo, 'opencode.json'));
  assert.notEqual((await call(sub, tool, { token: MARKER })).decision.decision, 'deny');
  // Without any .git above, only the working folder is read.
  const loose = path.join(dir, 'loose');
  const looseSub = path.join(loose, 'a');
  fs.mkdirSync(looseSub, { recursive: true });
  fs.writeFileSync(path.join(loose, 'opencode.json'), JSON.stringify({ mcp: { secrets: OURS } }));
  fs.rmSync(path.join(home, 'opencode'), { recursive: true });
  assert.equal((await call(looseSub, tool, { token: MARKER })).output.action, 'deny');
  assert.equal((await call(loose, tool, { token: MARKER })).output.action, 'deny');
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

// A copy of zn-gate (same package name, same file layout) at another place.
function fakePackage(dir) {
  fs.mkdirSync(path.join(dir, 'zn-gate', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'zn-gate', 'package.json'), JSON.stringify({ name: 'zn-gate' }));
  fs.writeFileSync(path.join(dir, 'zn-gate', 'bin', 'cli.js'), '// not the real one\n');
  return path.join(dir, 'zn-gate', 'bin', 'cli.js');
}
const denied = async (project) => (await call(project, TOOL, { token: MARKER })).output.action === 'deny';

test('opencode mcp: the genuine server (this package, also through a link) in the user config is trusted', async (t) => {
  const project = setup(t);
  userConfig({ mcp: { secrets: OURS } });
  assert.equal(await denied(project), false);
  // The same file reached through a link outside the project.
  const links = tempDir(t, 'zn-oclink-');
  const viaLink = path.join(links, 'zn-gate');
  fs.mkdirSync(path.join(viaLink, 'bin'), { recursive: true });
  fs.symlinkSync(OWN_CLI, path.join(viaLink, 'bin', 'cli.js'));
  fs.writeFileSync(path.join(viaLink, 'package.json'), JSON.stringify({ name: 'zn-gate' }));
  userConfig({ mcp: { secrets: { type: 'local', command: [process.execPath, path.join(viaLink, 'bin', 'cli.js'), 'secrets-mcp'] } } });
  assert.equal(await denied(project), false);
});

test('opencode mcp: a lookalike zn-gate/bin/cli.js in the project config is refused', async (t) => {
  const project = setup(t);
  const evil = fakePackage(path.join(project, 'evil'));
  fs.writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({ mcp: { secrets: { type: 'local', command: [process.execPath, evil, 'secrets-mcp'] } } }));
  assert.equal(await denied(project), true);
  fs.writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({ mcp: { secrets: OURS } }));
  assert.equal(await denied(project), true);
});

test('opencode mcp: a copy of zn-gate that is not the running package is refused in the user config', async (t) => {
  const project = setup(t);
  const elsewhere = fakePackage(tempDir(t, 'zn-occopy-'));
  userConfig({ mcp: { secrets: { type: 'local', command: [process.execPath, elsewhere, 'secrets-mcp', '--agent', 'opencode'] } } });
  assert.equal(await denied(project), true);
  // Also a link that points at such a copy.
  const links = tempDir(t, 'zn-occopylink-');
  fs.mkdirSync(path.join(links, 'zn-gate', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(links, 'zn-gate', 'package.json'), JSON.stringify({ name: 'zn-gate' }));
  fs.symlinkSync(elsewhere, path.join(links, 'zn-gate', 'bin', 'cli.js'));
  userConfig({ mcp: { secrets: { type: 'local', command: [process.execPath, path.join(links, 'zn-gate', 'bin', 'cli.js'), 'secrets-mcp'] } } });
  assert.equal(await denied(project), true);
  // A bare zn that the PATH resolves to something else.
  const bin = tempDir(t, 'zn-ocbin-');
  fs.symlinkSync(elsewhere, path.join(bin, 'zn'));
  userConfig({ mcp: { secrets: { type: 'local', command: ['zn', 'secrets-mcp'] } } });
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; });
  process.env.PATH = bin;
  assert.equal(await denied(project), true);
});

test('opencode mcp: a link in the project that points at the real package is not trusted', async (t) => {
  const project = setup(t);
  fs.mkdirSync(path.join(project, 'zn-gate', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(project, 'zn-gate', 'package.json'), JSON.stringify({ name: 'zn-gate' }));
  fs.symlinkSync(OWN_CLI, path.join(project, 'zn-gate', 'bin', 'cli.js'));
  const viaProject = { type: 'local', command: [process.execPath, path.join(project, 'zn-gate', 'bin', 'cli.js'), 'secrets-mcp'] };
  // In the project config.
  fs.writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({ mcp: { secrets: viaProject } }));
  assert.equal(await denied(project), true);
  fs.unlinkSync(path.join(project, 'opencode.json'));
  // In the user config, naming a path inside the project.
  userConfig({ mcp: { secrets: viaProject } });
  assert.equal(await denied(project), true);
});

test('opencode mcp: a server defined in OPENCODE_CONFIG_CONTENT is refused', async (t) => {
  const project = setup(t);
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ mcp: { secrets: OURS } });
  assert.equal(await denied(project), true);
  // And it spoils a genuine user-level entry of the same name.
  userConfig({ mcp: { secrets: OURS } });
  assert.equal(await denied(project), true);
});

test('opencode mcp: OPENCODE_CONFIG outside the project counts as user-level; inside it, it does not', async (t) => {
  const project = setup(t);
  const outside = tempDir(t, 'zn-occfg-');
  const file = path.join(outside, 'my.json');
  fs.writeFileSync(file, JSON.stringify({ mcp: { secrets: OURS } }));
  process.env.OPENCODE_CONFIG = file;
  assert.equal(await denied(project), false);
  const inside = path.join(project, 'cfg.json');
  fs.writeFileSync(inside, JSON.stringify({ mcp: { secrets: OURS } }));
  process.env.OPENCODE_CONFIG = inside;
  assert.equal(await denied(project), true);
  delete process.env.OPENCODE_CONFIG;
  fs.mkdirSync(path.join(project, 'cfgdir'));
  fs.writeFileSync(path.join(project, 'cfgdir', 'opencode.json'), JSON.stringify({ mcp: { secrets: OURS } }));
  process.env.OPENCODE_CONFIG_DIR = path.join(project, 'cfgdir');
  assert.equal(await denied(project), true);
});
