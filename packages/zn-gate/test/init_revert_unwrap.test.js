'use strict';
// `zn-gate init --wrap-mcp --revert` takes the zn-gate shield wrapper off each wrapped server in place.
// It does not copy an old backup over the file, so servers added later stay, and two wrap runs still revert fully.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { configureEnvironments } = require('../lib/init');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-unwrap-'));
const clean = (d) => fs.rmSync(d, { recursive: true, force: true });
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const jsonEnv = (f) => [{ name: 'T', id: 'claude-desktop', filePath: f, key: 'mcpServers', format: 'mcpServers-json' }];
const tomlEnv = (f) => [{ name: 'Codex', id: 'codex', filePath: f, key: 'mcp_servers', format: 'codex-toml' }];
const ocEnv = (f) => [{ name: 'OpenCode', id: 'opencode', filePath: f, key: 'mcp', format: 'opencode-json' }];

// Two runs in the same millisecond would pick the same backup name; give each run its own.
function withClock(fn) {
  const real = Date.now;
  let t = 1800000000000;
  Date.now = () => ++t;
  try { return fn(); } finally { Date.now = real; }
}

const FETCH = { command: 'uvx', args: ['mcp-server-fetch'] };
const GIT = { command: 'python3', args: ['-m', 'mcp_server_git', '--repository', '/example/repo'] };
const BARE = { command: 'my-server' };

test('wrap twice (a server added in between), then revert: every original command is back', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'mcp.json');
    fs.writeFileSync(f, JSON.stringify({ mcpServers: { fetch: FETCH } }, null, 2));
    withClock(() => {
      assert.equal(configureEnvironments({ envList: jsonEnv(f) }).actions[0].status, 'shielded');
      const cfg = json(f);
      cfg.mcpServers.git = GIT;
      cfg.mcpServers.bare = BARE;
      fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
      assert.equal(configureEnvironments({ envList: jsonEnv(f) }).actions[0].status, 'shielded');
      assert.equal(fs.readdirSync(d).filter((n) => n.includes('.bak.')).length, 2);

      const r = configureEnvironments({ envList: jsonEnv(f), revert: true });
      assert.equal(r.actions[0].status, 'reverted');
      assert.equal(r.actions[0].serversCount, 3);
      assert.deepEqual(json(f), { mcpServers: { fetch: FETCH, git: GIT, bare: BARE } });
      assert.equal(JSON.stringify(json(f)).includes('zn-gate'), false);

      const again = configureEnvironments({ envList: jsonEnv(f), revert: true });
      assert.equal(again.actions[0].status, 'nothing_to_revert');
    });
  } finally { clean(d); }
});

test('wrap, then add a server and another key, then revert: the additions stay and the original is back', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'mcp.json');
    fs.writeFileSync(f, JSON.stringify({ theme: 'dark', mcpServers: { fetch: FETCH } }, null, 2));
    withClock(() => {
      configureEnvironments({ envList: jsonEnv(f), shadow: true });
      const cfg = json(f);
      cfg.mcpServers.added = { command: 'node', args: ['added.js'] };
      cfg.userAddedAfterWrap = { keep: true };
      fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
      const r = configureEnvironments({ envList: jsonEnv(f), revert: true });
      assert.equal(r.actions[0].status, 'reverted');
      assert.equal(r.actions[0].serversCount, 1);
      assert.deepEqual(json(f), {
        theme: 'dark',
        mcpServers: { fetch: FETCH, added: { command: 'node', args: ['added.js'] } },
        userAddedAfterWrap: { keep: true },
      });
    });
  } finally { clean(d); }
});

test('nothing wrapped: it says so and leaves the file and the backups alone, even with an old backup next to it', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'mcp.json');
    const text = JSON.stringify({ mcpServers: { fetch: FETCH } }, null, 2);
    fs.writeFileSync(f, text);
    fs.writeFileSync(f + '.bak.1700000000000', '{"mcpServers":{"old":{"command":"old"}}}');
    const before = fs.readdirSync(d).sort();
    const r = configureEnvironments({ envList: jsonEnv(f), revert: true });
    assert.equal(r.actions[0].status, 'nothing_to_revert');
    assert.equal(fs.readFileSync(f, 'utf8'), text);
    assert.deepEqual(fs.readdirSync(d).sort(), before);
  } finally { clean(d); }
});

test('revert --dry-run reports what would change and writes nothing', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'mcp.json');
    fs.writeFileSync(f, JSON.stringify({ mcpServers: { fetch: FETCH } }, null, 2));
    withClock(() => configureEnvironments({ envList: jsonEnv(f) }));
    const wrappedText = fs.readFileSync(f, 'utf8');
    const before = fs.readdirSync(d).sort();
    const r = configureEnvironments({ envList: jsonEnv(f), revert: true, dryRun: true });
    assert.equal(r.actions[0].status, 'would_revert');
    assert.equal(r.actions[0].serversCount, 1);
    assert.equal(fs.readFileSync(f, 'utf8'), wrappedText);
    assert.deepEqual(fs.readdirSync(d).sort(), before);
  } finally { clean(d); }
});

test('a wrapper in a form zn-gate did not write is left in place and named; the others are still reverted', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'mcp.json');
    const odd = { command: 'npx', args: ['-y', 'zn-gate@1.0.0', 'shield', '--', 'uvx', 'x'] };
    fs.writeFileSync(f, JSON.stringify({ mcpServers: { fetch: FETCH, odd } }, null, 2));
    withClock(() => {
      configureEnvironments({ envList: jsonEnv(f) }); // wraps fetch only; odd already names zn-gate
      let r = configureEnvironments({ envList: jsonEnv(f), revert: true });
      assert.equal(r.actions[0].status, 'reverted');
      assert.equal(r.actions[0].serversCount, 1);
      assert.equal(r.actions[0].manual.length, 1);
      assert.match(r.actions[0].manual[0], /^odd: /);
      assert.deepEqual(json(f), { mcpServers: { fetch: FETCH, odd } });
      // Only the odd one is left: nothing to un-wrap, and it is still reported by name.
      r = configureEnvironments({ envList: jsonEnv(f), revert: true });
      assert.equal(r.actions[0].status, 'manual_required');
      assert.match(r.actions[0].manual[0], /^odd: /);
    });
  } finally { clean(d); }
});

test('Codex config.toml: wrap twice, add a server, revert; CRLF and other tables stay', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'config.toml');
    const lines = [
      'model = "o4-mini" # my model',
      '',
      '[mcp_servers.context7]',
      'command = "npx"',
      'args = ["-y", "@upstash/context7-mcp"]',
      '',
      '[mcp_servers.context7.env]',
      'KEY = "value"',
      '',
      '[mcp_servers.remote]',
      'url = "https://mcp.example.com/mcp"',
      '',
    ];
    fs.writeFileSync(f, lines.join('\r\n'));
    withClock(() => {
      assert.equal(configureEnvironments({ envList: tomlEnv(f) }).actions[0].status, 'shielded');
      fs.appendFileSync(f, '[mcp_servers.tool]\r\ncommand = "uvx"\r\nargs = ["tool-mcp", "--flag"]\r\n\r\n[profile]\r\nname = "work"\r\n');
      assert.equal(configureEnvironments({ envList: tomlEnv(f) }).actions[0].status, 'shielded');
      const r = configureEnvironments({ envList: tomlEnv(f), revert: true });
      assert.equal(r.actions[0].status, 'reverted');
      assert.equal(r.actions[0].serversCount, 2);
    });
    const out = fs.readFileSync(f, 'utf8');
    assert.ok(out.includes('command = "npx"'));
    assert.ok(out.includes('command = "npx"\r\nargs = ["-y", "@upstash/context7-mcp"]\r\n'), out);
    assert.ok(out.includes('command = "uvx"\r\nargs = ["tool-mcp", "--flag"]\r\n'), out);
    assert.ok(out.includes('[mcp_servers.context7.env]\r\nKEY = "value"'));
    assert.ok(out.includes('url = "https://mcp.example.com/mcp"'));
    assert.ok(out.includes('[profile]\r\nname = "work"'));
    assert.ok(out.startsWith('model = "o4-mini" # my model\r\n'));
    assert.equal(/zn-gate|shield/.test(out), false, out);
    assert.equal(/[^\r]\n/.test(out), false, 'no bare LF was introduced');
  } finally { clean(d); }
});

test('Codex config.toml: trailing comments and each line ending survive the un-wrap', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'config.toml');
    const text = [
      '[mcp_servers.a]\r',
      'command = "npx" # docs\r',
      'args = ["-y", "zn-gate", "shield", "--", "uvx", "tool"] # pinned\r',
      '\r',
      '[mcp_servers.b]',
      "command = 'npx'",
      "args = ['-y', 'zn-gate', 'shield', '--shadow', '--', 'solo'] # b",
      '',
    ].join('\n');
    fs.writeFileSync(f, text);
    const r = configureEnvironments({ envList: tomlEnv(f), revert: true });
    assert.equal(r.actions[0].status, 'reverted');
    assert.equal(r.actions[0].serversCount, 2);
    assert.equal(fs.readFileSync(f, 'utf8'), [
      '[mcp_servers.a]\r',
      'command = "uvx" # docs\r',
      'args = ["tool"] # pinned\r',
      '\r',
      '[mcp_servers.b]',
      'command = "solo"',
      'args = [] # b',
      '',
    ].join('\n'));
  } finally { clean(d); }
});

test('Codex config.toml: a server wrapped with no args gets its original back with no args line', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'config.toml');
    fs.writeFileSync(f, '[mcp_servers.solo]\ncommand = "my-server"\n\n[other]\nx = 1\n');
    withClock(() => {
      configureEnvironments({ envList: tomlEnv(f), shadow: true });
      assert.match(fs.readFileSync(f, 'utf8'), /shield/);
      const r = configureEnvironments({ envList: tomlEnv(f), revert: true });
      assert.equal(r.actions[0].status, 'reverted');
    });
    assert.equal(fs.readFileSync(f, 'utf8'), '[mcp_servers.solo]\ncommand = "my-server"\n\n[other]\nx = 1\n');
  } finally { clean(d); }
});

test('Codex config.toml: a multi-line args entry that names the shield is reported, not rewritten', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'config.toml');
    const text = '[mcp_servers.x]\ncommand = "npx"\nargs = [\n  "-y",\n  "zn-gate",\n  "shield",\n  "--",\n  "uvx"\n]\n';
    fs.writeFileSync(f, text);
    const r = configureEnvironments({ envList: tomlEnv(f), revert: true });
    assert.equal(r.actions[0].status, 'manual_required');
    assert.match(r.actions[0].manual[0], /^x: /);
    assert.equal(fs.readFileSync(f, 'utf8'), text);
  } finally { clean(d); }
});

test('OpenCode: wrap twice with a server added in between, then revert', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'opencode.json');
    const a = { type: 'local', command: ['npx', '-y', 'my-mcp'], enabled: true };
    const remote = { type: 'remote', url: 'https://mcp.example.com/mcp' };
    fs.writeFileSync(f, JSON.stringify({ mcp: { a, remote } }, null, 2));
    withClock(() => {
      configureEnvironments({ envList: ocEnv(f) });
      const cfg = json(f);
      cfg.mcp.b = { type: 'local', command: ['python3', 'b.py'] };
      cfg.model = 'example/model';
      fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
      configureEnvironments({ envList: ocEnv(f), shadow: true });
      const r = configureEnvironments({ envList: ocEnv(f), revert: true });
      assert.equal(r.actions[0].status, 'reverted');
      assert.equal(r.actions[0].serversCount, 2);
    });
    assert.deepEqual(json(f), { mcp: { a, remote, b: { type: 'local', command: ['python3', 'b.py'] } }, model: 'example/model' });
  } finally { clean(d); }
});

test('the CLI says when nothing was wrapped, and exits 1 when a wrapper is left for you to fix', () => {
  const d = tmp();
  try {
    const hm = path.join(d, 'home');
    fs.mkdirSync(path.join(hm, '.cursor'), { recursive: true });
    const f = path.join(hm, '.cursor', 'mcp.json');
    fs.writeFileSync(f, JSON.stringify({ mcpServers: { fetch: FETCH } }, null, 2));
    const run = () => spawnSync(process.execPath, [CLI, 'init', '--revert'], {
      cwd: d,
      env: { PATH: process.env.PATH, HOME: hm, USERPROFILE: hm, APPDATA: path.join(hm, 'AppData'), XDG_CONFIG_HOME: path.join(hm, '.config') },
      encoding: 'utf8',
    });
    let r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\[nothing_to_revert\]/);
    assert.match(r.stdout, /Nothing was reverted/);
    assert.doesNotMatch(r.stdout, /\[reverted\]/);

    fs.writeFileSync(f, JSON.stringify({ mcpServers: { fetch: { command: 'npx', args: ['-y', 'zn-gate@1.0.0', 'shield', '--', 'uvx'] } } }, null, 2));
    r = run();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /still wrapped, fix by hand: fetch/);
  } finally { clean(d); }
});
