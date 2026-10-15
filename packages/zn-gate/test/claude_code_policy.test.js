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
  return { managedDir: dir, userSettings: [userFile] };
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
  const w = warn(setup(t, { managed: { allowManagedHooksOnly: true } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /allowManagedHooksOnly/);
});

test('allowManagedHooksOnly with zn deployed in the managed hooks: no warning', (t) => {
  assert.deepEqual(warn(setup(t, { managed: { allowManagedHooksOnly: true, hooks: { PreToolUse: [OUR_HOOK] } } })), []);
  // the hooks may come from a drop-in file
  assert.deepEqual(warn(setup(t, { managed: { allowManagedHooksOnly: true }, drop: { '10-zn.json': { hooks: { PreToolUse: [OUR_HOOK] } } } })), []);
});

test('a drop-in file is read too', (t) => {
  const w = warn(setup(t, { drop: { '20-org.json': { disableAllHooks: true }, 'notes.txt': {} } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /managed-settings\.d/);
});

test('disableAllHooks in the user settings', (t) => {
  const w = warn(setup(t, { user: { disableAllHooks: true } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /settings\.json sets disableAllHooks/);
  assert.match(w[0], /Remove that setting/);
});

test('managed-mcp.json without "secrets"', (t) => {
  const w = warn(setup(t, { mcp: { mcpServers: { github: { command: 'gh-mcp' } } } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /managed-mcp\.json\) loads only the MCP servers it lists/);
  assert.deepEqual(warn(setup(t, { mcp: { mcpServers: { secrets: { command: 'node', args: ['cli.js', 'secrets-mcp'] } } } })), []);
  // --no-mcp: nothing to say about MCP
  assert.deepEqual(warn(setup(t, { mcp: { mcpServers: {} } }), { mcp: false }), []);
});

test('MCP allowlist and denylist', (t) => {
  let w = warn(setup(t, { managed: { allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverName: 'github' }] } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /allowManagedMcpServersOnly/);
  assert.deepEqual(warn(setup(t, { managed: { allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverName: 'secrets' }] } })), []);
  // the exclusive allowlist ignores the user's own allowlist
  w = warn(setup(t, { managed: { allowManagedMcpServersOnly: true, allowedMcpServers: [] }, user: { allowedMcpServers: [{ serverName: 'secrets' }] } }));
  assert.equal(w.length, 1);
  // without it, the user's allowlist adds to the managed one
  w = warn(setup(t, { managed: { allowedMcpServers: [{ serverName: 'github' }] } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /Add \{"serverName": "secrets"\}/);
  assert.deepEqual(warn(setup(t, { managed: { allowedMcpServers: [{ serverName: 'github' }] }, user: { allowedMcpServers: [{ serverName: 'secrets' }] } })), []);
  // a denylist entry wins, from any scope
  w = warn(setup(t, { managed: { allowedMcpServers: [{ serverName: 'secrets' }], deniedMcpServers: [{ serverName: 'secrets' }] } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /blocks the "secrets" MCP server \(deniedMcpServers\)/);
  w = warn(setup(t, { user: { deniedMcpServers: [{ serverCommand: ['node', 'cli.js', 'secrets-mcp', '--agent', 'claude-code'] }] } }));
  assert.equal(w.length, 1);
  assert.match(w[0], /^.*settings\.json blocks/);
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
