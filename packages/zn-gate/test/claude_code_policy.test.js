'use strict';
/*
 * Claude Code organization settings that stop zn's hooks or its "secrets"
 * MCP server: `zn hooks install claude-code` and `zn-gate status` say so.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { claudeCodePolicyWarnings, managedDir } = require('../lib/agents/managed-policy');
const adapter = require('../lib/agents/claude-code');

const OUR_HOOK = { matcher: 'Bash', hooks: [{ type: 'command', command: "'/usr/bin/node' '/opt/zn/lib/hooks/runner.js' claude-code" }] };
const CMD = ['/usr/bin/node', '/opt/zn/bin/cli.js', 'secrets-mcp', '--agent', 'claude-code'];

function setup(t, { managed, drop, mcp, user } = {}) {
  const root = tempDir(t, 'zn-ccpol-');
  const dir = path.join(root, 'managed');
  fs.mkdirSync(dir, { recursive: true });
  if (managed !== undefined) fs.writeFileSync(path.join(dir, 'managed-settings.json'), typeof managed === 'string' ? managed : JSON.stringify(managed));
  if (drop) {
    fs.mkdirSync(path.join(dir, 'managed-settings.d'));
    for (const [name, data] of Object.entries(drop)) fs.writeFileSync(path.join(dir, 'managed-settings.d', name), JSON.stringify(data));
  }
  if (mcp !== undefined) fs.writeFileSync(path.join(dir, 'managed-mcp.json'), JSON.stringify(mcp));
  const userFile = path.join(root, 'settings.json');
  if (user !== undefined) fs.writeFileSync(userFile, JSON.stringify(user));
  return { managedDir: dir, userSettings: [userFile], mcpCommand: CMD };
}

const warn = (o, extra = {}) => claudeCodePolicyWarnings({ ...o, ...extra });

test('no managed settings: no warning', (t) => {
  assert.deepEqual(warn(setup(t)), []);
  assert.deepEqual(warn(setup(t, { user: { hooks: {} } })), []);
});

test('disableAllHooks in managed settings', (t) => {
  const w = warn(setup(t, { managed: { disableAllHooks: true } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /turns off all hooks \(disableAllHooks\)/);
  assert.match(w[0], /managed-settings\.json/);
  assert.match(w[0], /Ask your administrator/);
});

test('allowManagedHooksOnly without zn in the managed hooks', (t) => {
  let w = warn(setup(t, { managed: { allowManagedHooksOnly: true } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /allowManagedHooksOnly/);
  // a string "true" is read the same way (fails toward warning)
  w = warn(setup(t, { managed: { allowManagedHooksOnly: 'true' } }));
  assert.equal(w.length, 1);
});

test('allowManagedHooksOnly with zn deployed in the managed hooks: no warning', (t) => {
  assert.deepEqual(warn(setup(t, { managed: { allowManagedHooksOnly: true, hooks: { PreToolUse: [OUR_HOOK] } } })), []);
  // the hooks may come from a drop-in file
  assert.deepEqual(warn(setup(t, { managed: { allowManagedHooksOnly: true }, drop: { '10-zn.json': { hooks: { PreToolUse: [OUR_HOOK] } } } })), []);
});

test('drop-in files are read, and a later file replaces a value', (t) => {
  const w = warn(setup(t, { drop: { '20-org.json': { disableAllHooks: true }, 'notes.txt': {} } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /managed-settings\.d/);
  assert.deepEqual(warn(setup(t, { managed: { disableAllHooks: true }, drop: { '20-x.json': { disableAllHooks: false } } })), []);
  assert.deepEqual(warn(setup(t, { managed: { allowManagedHooksOnly: true }, drop: { '20-x.json': { allowManagedHooksOnly: false } } })), []);
});

test('disableAllHooks in the user settings', (t) => {
  const w = warn(setup(t, { user: { disableAllHooks: true } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /settings\.json sets disableAllHooks/);
  assert.match(w[0], /Remove that setting/);
  // it cannot turn off zn deployed as a managed hook
  assert.deepEqual(warn(setup(t, { managed: { hooks: { PreToolUse: [OUR_HOOK] } }, user: { disableAllHooks: true } })), []);
});

test('managed-mcp.json without zn\'s server', (t) => {
  const w = warn(setup(t, { mcp: { mcpServers: { github: { command: 'gh-mcp' } } } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /managed-mcp\.json\) loads only the MCP servers it lists/);
  assert.deepEqual(warn(setup(t, { mcp: { mcpServers: { secrets: { command: 'node', args: ['cli.js', 'secrets-mcp'] } } } })), []);
  // listed under another name: it still runs
  assert.deepEqual(warn(setup(t, { mcp: { mcpServers: { 'zn-secrets': { command: 'node', args: ['cli.js', 'secrets-mcp'] } } } })), []);
  // listed there, it skips the allowlist
  assert.deepEqual(warn(setup(t, { mcp: { mcpServers: { zn: { command: 'node', args: ['cli.js', 'secrets-mcp'] } } }, managed: { allowedMcpServers: [{ serverName: 'github' }] } })), []);
  // the server is not installed: nothing to say about MCP
  assert.deepEqual(warn(setup(t, { mcp: { mcpServers: {} } }), { mcp: false }), []);
});

test('exclusive MCP allowlist (allowManagedMcpServersOnly)', (t) => {
  const w = warn(setup(t, { managed: { allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverName: 'github' }] } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /allowManagedMcpServersOnly/);
  assert.deepEqual(warn(setup(t, { managed: { allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverName: 'secrets' }] } })), []);
  // the user's own allowlist does not count then
  assert.equal(warn(setup(t, { managed: { allowManagedMcpServersOnly: true, allowedMcpServers: [] }, user: { allowedMcpServers: [{ serverName: 'secrets' }] } })).length, 1);
  // no managed allowlist: nothing is restricted
  assert.deepEqual(warn(setup(t, { managed: { allowManagedMcpServersOnly: true } })), []);
});

test('MCP allowlists add up across scopes', (t) => {
  let w = warn(setup(t, { managed: { allowedMcpServers: [{ serverName: 'github' }] } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /allowedMcpServers\) that does not include/);
  assert.deepEqual(warn(setup(t, { managed: { allowedMcpServers: [{ serverName: 'github' }] }, user: { allowedMcpServers: [{ serverName: 'secrets' }] } })), []);
  // a user-only allowlist restricts too
  w = warn(setup(t, { user: { allowedMcpServers: [{ serverName: 'github' }] } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /^.*settings\.json has an MCP allowlist/);
});

test('a stdio server needs its exact command once the allowlist names commands', (t) => {
  const other = { serverCommand: ['npx', 'other-mcp'] };
  assert.equal(warn(setup(t, { managed: { allowedMcpServers: [{ serverName: 'secrets' }, other] } })).length, 1);
  assert.deepEqual(warn(setup(t, { managed: { allowedMcpServers: [{ serverCommand: CMD }, other] } })), []);
  // a near miss (another node path) does not match
  const near = ['/opt/node', ...CMD.slice(1)];
  assert.equal(warn(setup(t, { managed: { allowedMcpServers: [{ serverCommand: near }] } })).length, 1);
});

test('MCP denylist, from any scope', (t) => {
  let w = warn(setup(t, { managed: { allowedMcpServers: [{ serverName: 'secrets' }], deniedMcpServers: [{ serverName: 'secrets' }] } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /blocks the "secrets" MCP server \(deniedMcpServers\)/);
  w = warn(setup(t, { user: { deniedMcpServers: [{ serverCommand: CMD }] } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /^.*settings\.json blocks/);
  // an unrelated command that also contains secrets-mcp is not ours
  assert.deepEqual(warn(setup(t, { user: { deniedMcpServers: [{ serverCommand: ['other', 'secrets-mcp'] }] } })), []);
});

test('an unreadable or invalid managed file is reported, never thrown', (t) => {
  const w = warn(setup(t, { managed: '{ not json' }));
  assert.equal(w.length, 1);
  assert.match(w[0], /could not read the Claude Code managed settings .*invalid JSON/);
});

test('managed settings location per platform', () => {
  assert.equal(managedDir('darwin'), '/Library/Application Support/ClaudeCode');
  assert.equal(managedDir('linux'), '/etc/claude-code');
  assert.equal(managedDir('win32'), 'C:\\Program Files\\ClaudeCode');
});

test('zn hooks install claude-code reports the policy in its notes', (t) => {
  const o = setup(t, { managed: { allowManagedHooksOnly: true } });
  const home = tempDir(t, 'zn-ccpol-home-');
  const report = adapter.install({ home, env: {}, mcp: false, managedDir: o.managedDir, command: 'node runner.js claude-code' });
  assert.ok(report.warnings.some((w) => /allowManagedHooksOnly/.test(w)), report.warnings.join('\n'));
});
