'use strict';

// `zn team managed-config` prints what an administrator deploys with MDM. It writes nothing, uses the
// same hook commands as `zn hooks install`, and what it prints is accepted by zn's own managed-policy check.
// Fixtures: test/fixtures/managed-config/. Regenerate with ZN_UPDATE_FIXTURES=1 after a deliberate change.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mc = require('../lib/team/managed-config');
const { claudeCodePolicyWarnings, codexPolicyWarnings } = require('../lib/agents/managed-policy');
const { parseToml } = require('../lib/audit/parse');
const cfg = require('../lib/agents/config-file');
const { getAdapter } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const FIX = path.join(__dirname, 'fixtures', 'managed-config');
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

const PATHS = {
  'claude-code': {
    macos: '/Library/Application Support/ClaudeCode/managed-settings.json',
    linux: '/etc/claude-code/managed-settings.json',
    windows: 'C:\\Program Files\\ClaudeCode\\managed-settings.json',
  },
  cursor: {
    macos: '/Library/Application Support/Cursor/hooks.json',
    linux: '/etc/cursor/hooks.json',
    windows: 'C:\\ProgramData\\Cursor\\hooks.json',
  },
  codex: {
    macos: '/etc/codex/requirements.toml',
    linux: '/etc/codex/requirements.toml',
    windows: '%ProgramData%\\OpenAI\\Codex\\requirements.toml',
  },
};

const VARIANTS = [
  { name: 'default', opts: {} },
  { name: 'managed-hooks-only', opts: { managedHooksOnly: true } },
];

function fixtureName(f, variant) {
  return f.agent + '-' + f.os + (variant === 'default' ? '' : '-' + variant) + '.' + f.format;
}

test('every agent and OS matches its fixture, with the right path', () => {
  const update = process.env.ZN_UPDATE_FIXTURES === '1';
  if (update) fs.mkdirSync(FIX, { recursive: true });
  for (const v of VARIANTS) {
    const files = mc.build({ agent: 'all', os: 'all', ...v.opts }).filter((f) => !f.file.endsWith('managed-mcp.json'));
    assert.equal(files.length, 9);
    for (const f of files) {
      assert.equal(f.file, PATHS[f.agent][f.os], f.agent + ' ' + f.os);
      const fx = path.join(FIX, fixtureName(f, v.name));
      if (update) fs.writeFileSync(fx, f.content);
      assert.equal(f.content, fs.readFileSync(fx, 'utf8'), path.basename(fx));
    }
  }
  const mcp = mc.build({ agent: 'claude-code', os: 'all', exclusiveMcp: true }).filter((f) => f.file.endsWith('managed-mcp.json'));
  assert.equal(mcp.length, 3);
  for (const f of mcp) {
    const fx = path.join(FIX, 'claude-code-' + f.os + '-managed-mcp.json');
    if (update) fs.writeFileSync(fx, f.content);
    assert.equal(f.content, fs.readFileSync(fx, 'utf8'));
    assert.match(f.notes.join(' '), /exclusive control of MCP/);
  }
});

test('Claude Code: official settings shape, hooks are zn\'s, allowManagedHooksOnly only on request', () => {
  const plain = JSON.parse(mc.build({ agent: 'claude-code', os: 'linux' })[0].content);
  assert.deepEqual(Object.keys(plain), ['hooks']);
  assert.deepEqual(Object.keys(plain.hooks).sort(), ['PostToolUse', 'PreToolUse', 'UserPromptExpansion', 'UserPromptSubmit']);
  for (const groups of Object.values(plain.hooks)) {
    for (const g of groups) {
      assert.ok(Array.isArray(g.hooks) && (g.matcher === undefined || typeof g.matcher === 'string'));
      for (const h of g.hooks) {
        assert.equal(h.type, 'command');
        assert.equal(h.command, 'zn hook claude-code');
        assert.ok(cfg.isOurs(h.command, 'claude-code'));
        assert.ok(Number.isInteger(h.timeout) && h.timeout > 0);
      }
    }
  }
  const only = JSON.parse(mc.build({ agent: 'claude-code', os: 'linux', managedHooksOnly: true })[0].content);
  assert.equal(only.allowManagedHooksOnly, true);
  assert.equal(plain.allowManagedHooksOnly, undefined);
  assert.equal(plain.managedMcpServers, undefined);
  // managedMcpServers takes no command (official docs), so the stdio server is never put there.
  assert.equal(only.managedMcpServers, undefined);
});

test('Claude Code: the printed files satisfy zn\'s own managed-settings check', (t) => {
  const dir = tempDir(t, 'zn-mc-claude-');
  const files = mc.build({ agent: 'claude-code', os: 'linux', managedHooksOnly: true, exclusiveMcp: true });
  for (const f of files) fs.writeFileSync(path.join(dir, path.basename(f.file)), f.content);
  const mcp = JSON.parse(files[1].content).mcpServers.secrets;
  assert.deepEqual(mcp, { type: 'stdio', command: 'zn', args: ['secrets-mcp', '--agent', 'claude-code'] });
  assert.deepEqual(claudeCodePolicyWarnings({ managedDir: dir, userSettings: [], mcp: true, mcpCommand: ['zn', 'secrets-mcp', '--agent', 'claude-code'] }), []);
  assert.equal(getAdapter('claude-code').isZnSecretsServer(mcp), true);
});

test('Cursor: version 1, failClosed on reads and prompts only, same entries as the installer', (t) => {
  const f = mc.build({ agent: 'cursor', os: 'macos' })[0];
  const data = JSON.parse(f.content);
  assert.equal(data.version, 1);
  const closed = Object.entries(data.hooks).filter(([, list]) => list[0].failClosed === true).map(([e]) => e).sort();
  assert.deepEqual(closed, ['beforeReadFile', 'beforeSubmitPrompt']);
  for (const list of Object.values(data.hooks)) {
    assert.equal(list.length, 1);
    assert.equal(list[0].command, 'zn hook cursor');
    assert.ok(cfg.isOurs(list[0].command, 'cursor'));
  }
  // The installer writes the same entries for the same command.
  const home = tempDir(t, 'zn-mc-cursor-');
  getAdapter('cursor').install({ home, command: 'zn hook cursor', mcp: false });
  const written = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8'));
  assert.deepEqual(written.hooks, data.hooks);
  // Cursor has no managed-hooks-only switch: the option changes nothing in the file.
  assert.equal(mc.build({ agent: 'cursor', os: 'macos', managedHooksOnly: true })[0].content, f.content);
});

test('Codex: valid TOML in the documented layout, recognized by the policy check', (t) => {
  const plain = mc.build({ agent: 'codex', os: 'linux' })[0].content;
  const data = parseToml(plain).data;
  assert.equal(data.allow_managed_hooks_only, undefined);
  assert.equal(data.features.hooks, true);
  assert.deepEqual(Object.keys(data.hooks).sort(), ['PermissionRequest', 'PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
  for (const groups of Object.values(data.hooks)) {
    assert.equal(groups.length, 1);
    assert.equal(groups[0].hooks.length, 1);
    const h = groups[0].hooks[0];
    assert.equal(h.type, 'command');
    assert.equal(h.command, 'zn hook codex');
    assert.equal(h.command_windows, 'zn hook codex');
    assert.ok(Number.isInteger(h.timeout));
  }
  assert.equal(data.hooks.PreToolUse[0].matcher, '^(Bash|apply_patch|mcp__.+)$');
  // Whole requirements file with managed-hooks-only: zn is among the managed hooks, so no warning.
  const dir = tempDir(t, 'zn-mc-codex-');
  const file = path.join(dir, 'requirements.toml');
  const only = mc.build({ agent: 'codex', os: 'linux', managedHooksOnly: true })[0].content;
  assert.match(only, /^allow_managed_hooks_only = true$/m);
  assert.equal(parseToml(only).data.allow_managed_hooks_only, true);
  fs.writeFileSync(file, only);
  assert.deepEqual(codexPolicyWarnings({ requirementsFile: file, managedConfigFile: path.join(dir, 'none.toml'), codexHome: dir, env: {} }), []);
});

test('the command prints and writes nothing, in text and JSON', (t) => {
  const cwd = tempDir(t, 'zn-mc-cli-');
  const run = (...a) => spawnSync(process.execPath, [CLI, 'team', 'managed-config', ...a], { cwd, encoding: 'utf8', env: { ...process.env, HOME: cwd, USERPROFILE: cwd } });
  const j = run('--agent', 'all', '--os', 'all', '--json');
  assert.equal(j.status, 0, j.stderr);
  const out = JSON.parse(j.stdout);
  assert.equal(out.schema, 1);
  assert.equal(out.files.length, 9);
  for (const f of out.files) {
    assert.ok(f.file && f.content && f.docs && f.read === '2026-10-19' && Array.isArray(f.notes));
  }
  const txt = run('--agent', 'claude', '--os', 'windows', '--managed-hooks-only');
  assert.equal(txt.status, 0, txt.stderr);
  assert.match(txt.stdout, /File: C:\\Program Files\\ClaudeCode\\managed-settings\.json/);
  assert.match(txt.stdout, /"allowManagedHooksOnly": true/);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('bad options are a usage error (exit 2)', (t) => {
  const cwd = tempDir(t, 'zn-mc-bad-');
  for (const a of [['--agent', 'vim'], ['--os', 'beos'], ['--bogus'], ['--agent']]) {
    const r = spawnSync(process.execPath, [CLI, 'team', 'managed-config', ...a], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 2, a.join(' '));
    assert.match(r.stderr, /usage: zn team managed-config/);
    assert.equal(r.stdout, '');
  }
});
