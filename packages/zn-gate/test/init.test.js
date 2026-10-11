'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getKnownEnvironments, scanEnvironments, configureEnvironments } = require('../lib/init');

test('zn-gate init - getKnownEnvironments returns list of supported agents', () => {
  const envs = getKnownEnvironments();
  assert.ok(envs.length >= 7);
  const ids = envs.map(e => e.id);
  assert.ok(ids.includes('claude-desktop'));
  assert.ok(ids.includes('cursor'));
  assert.ok(ids.includes('opencode'));
});

test('zn-gate init - scanEnvironments detects active MCP configs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-scan-'));
  const testClaude = path.join(tmpDir, 'claude.json');
  fs.writeFileSync(testClaude, JSON.stringify({
    mcpServers: {
      fetch: { command: 'uvx', args: ['mcp-server-fetch'] }
    }
  }, null, 2));

  try {
    const mockList = [
      { name: 'Claude Desktop', id: 'claude-desktop', filePath: testClaude, key: 'mcpServers' },
      { name: 'Nonexistent', id: 'fake', filePath: path.join(tmpDir, 'no.json'), key: 'mcpServers' }
    ];

    const results = scanEnvironments(mockList);
    assert.equal(results.length, 2);

    const found = results.find(r => r.id === 'claude-desktop');
    assert.equal(found.exists, true);
    assert.equal(found.serverCount, 1);
    assert.equal(found.allShielded, false);

    const missing = results.find(r => r.id === 'fake');
    assert.equal(missing.exists, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('zn-gate init - configureEnvironments dryRun does not alter configs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-dry-'));
  const testClaude = path.join(tmpDir, 'claude.json');
  fs.writeFileSync(testClaude, JSON.stringify({
    mcpServers: {
      fetch: { command: 'uvx', args: ['mcp-server-fetch'] }
    }
  }, null, 2));

  try {
    const mockList = [
      { name: 'Claude Desktop', id: 'claude-desktop', filePath: testClaude, key: 'mcpServers' }
    ];

    const { actions } = configureEnvironments({ envList: mockList, dryRun: true });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].status, 'would_shield');

    // Confirm file was untouched
    const after = JSON.parse(fs.readFileSync(testClaude, 'utf8'));
    assert.equal(after.mcpServers.fetch.command, 'uvx');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('zn-gate init - configureEnvironments wraps servers with zn-gate shield and creates backup', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-wrap-'));
  const testClaude = path.join(tmpDir, 'claude.json');
  fs.writeFileSync(testClaude, JSON.stringify({
    mcpServers: {
      fetch: { command: 'uvx', args: ['mcp-server-fetch'] }
    }
  }, null, 2));

  try {
    const mockList = [
      { name: 'Claude Desktop', id: 'claude-desktop', filePath: testClaude, key: 'mcpServers' }
    ];

    const { actions } = configureEnvironments({ envList: mockList });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].status, 'shielded');

    const updated = JSON.parse(fs.readFileSync(testClaude, 'utf8'));
    assert.equal(updated.mcpServers.fetch.command, 'npx');
    assert.ok(updated.mcpServers.fetch.args.includes('shield'));

    // Check backup was created
    const files = fs.readdirSync(tmpDir);
    const backupFile = files.find(f => f.includes('bak'));
    assert.ok(backupFile, 'Backup file should exist');

    // Revert test
    const revertRes = configureEnvironments({ envList: mockList, revert: true });
    assert.equal(revertRes.actions[0].status, 'reverted');

    const reverted = JSON.parse(fs.readFileSync(testClaude, 'utf8'));
    assert.equal(reverted.mcpServers.fetch.command, 'uvx');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1.4.1: correct config locations and formats for Codex CLI and OpenCode
// ---------------------------------------------------------------------------

test('zn-gate init - known paths: Codex uses config.toml, OpenCode uses ~/.config/opencode/opencode.json', () => {
  const envs = getKnownEnvironments();
  const codex = envs.find(e => e.id === 'codex');
  const opencode = envs.find(e => e.id === 'opencode');
  assert.equal(codex.format, 'codex-toml');
  assert.equal(path.basename(codex.filePath), 'config.toml');
  assert.equal(opencode.format, 'opencode-json');
  assert.ok(/opencode\.jsonc?$/.test(opencode.filePath));
  assert.equal(path.basename(path.dirname(opencode.filePath)), 'opencode');
  if (process.platform === 'linux' && !process.env.XDG_CONFIG_HOME) {
    const cd = envs.find(e => e.id === 'claude-desktop');
    assert.equal(cd.filePath, path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json'));
  }
});

test('zn-gate init - Codex config.toml: wraps stdio servers, keeps env tables and url servers, reverts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-codex-'));
  const file = path.join(tmpDir, 'config.toml');
  const original = [
    'model = "o4-mini"',
    '',
    '[mcp_servers.context7]',
    'command = "npx"',
    'args = ["-y", "@upstash/context7-mcp"]',
    '',
    '[mcp_servers.context7.env]',
    'MY_ENV_VAR = "MY_ENV_VALUE"',
    '',
    '[mcp_servers."fetch-srv"]',
    "command = 'uvx' # inline comment",
    '',
    '[mcp_servers.remote]',
    'url = "https://mcp.example.com/mcp"',
    '',
  ].join('\n');
  fs.writeFileSync(file, original);
  const mockList = [{ name: 'Codex', id: 'codex', filePath: file, key: 'mcp_servers', format: 'codex-toml' }];
  try {
    const scan = scanEnvironments(mockList)[0];
    assert.equal(scan.serverCount, 3);
    assert.equal(scan.allShielded, false);

    const { actions } = configureEnvironments({ envList: mockList });
    assert.equal(actions[0].status, 'shielded');
    const out = fs.readFileSync(file, 'utf8');
    assert.ok(out.includes('args = ["-y", "zn-gate", "shield", "--", "npx", "-y", "@upstash/context7-mcp"]'));
    assert.ok(out.includes('args = ["-y", "zn-gate", "shield", "--", "uvx"]'), 'server without args gets an args line');
    assert.ok(out.includes('[mcp_servers.context7.env]\nMY_ENV_VAR = "MY_ENV_VALUE"'));
    assert.ok(out.includes('url = "https://mcp.example.com/mcp"'));
    assert.ok(out.startsWith('model = "o4-mini"'));
    assert.equal(scanEnvironments(mockList)[0].allShielded, true);

    // idempotent
    const again = configureEnvironments({ envList: mockList });
    assert.equal(again.actions[0].status, 'already_shielded');

    const rev = configureEnvironments({ envList: mockList, revert: true });
    assert.equal(rev.actions[0].status, 'reverted');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('zn-gate init - Codex config.toml with multi-line args is left untouched and reported', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-codex-ml-'));
  const file = path.join(tmpDir, 'config.toml');
  const original = '[mcp_servers.x]\ncommand = "npx"\nargs = [\n  "-y",\n  "pkg"\n]\n';
  fs.writeFileSync(file, original);
  const mockList = [{ name: 'Codex', id: 'codex', filePath: file, key: 'mcp_servers', format: 'codex-toml' }];
  try {
    const { actions } = configureEnvironments({ envList: mockList });
    assert.equal(actions[0].status, 'manual_required');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('zn-gate init - OpenCode opencode.json: wraps local servers (command array), skips remote, reverts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-oc-'));
  const file = path.join(tmpDir, 'opencode.json');
  const original = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      local1: { type: 'local', command: ['npx', '-y', 'my-mcp-command'], enabled: true, environment: { A: 'b' } },
      remote1: { type: 'remote', url: 'https://mcp.example.com/mcp' },
    },
  }, null, 2);
  fs.writeFileSync(file, original);
  const mockList = [{ name: 'OpenCode', id: 'opencode', filePath: file, key: 'mcp', format: 'opencode-json' }];
  try {
    const { actions } = configureEnvironments({ envList: mockList, shadow: true });
    assert.equal(actions[0].status, 'shielded');
    const out = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(out.mcp.local1.command, ['npx', '-y', 'zn-gate', 'shield', '--shadow', '--', 'npx', '-y', 'my-mcp-command']);
    assert.equal(out.mcp.local1.type, 'local');
    assert.deepEqual(out.mcp.local1.environment, { A: 'b' });
    assert.deepEqual(out.mcp.remote1, { type: 'remote', url: 'https://mcp.example.com/mcp' });
    assert.equal(out.mcp.local1.args, undefined, 'OpenCode has no args key');

    const rev = configureEnvironments({ envList: mockList, revert: true });
    assert.equal(rev.actions[0].status, 'reverted');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('zn-gate init - OpenCode JSONC with comments is not rewritten', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-ocjsonc-'));
  const file = path.join(tmpDir, 'opencode.jsonc');
  const original = '{\n  // my servers\n  "mcp": { "x": { "type": "local", "command": ["npx", "y"] } }\n}\n';
  fs.writeFileSync(file, original);
  const mockList = [{ name: 'OpenCode', id: 'opencode', filePath: file, key: 'mcp', format: 'opencode-json' }];
  try {
    const { actions } = configureEnvironments({ envList: mockList });
    assert.equal(actions[0].status, 'manual_required');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
