'use strict';

// zn-gate init --wrap-mcp after init --shadow switches the shadow-wrapped servers to enforce (the documented "try
// shadow first, then enforce" path), and init --shadow never weakens a server that already enforces. Run through the
// CLI with a temporary home holding fake Cursor and Claude Code configs.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { AGENT_ENV_VARS } = require('../lib/broker/tty');
const { tempDir } = require('./helpers/tmp');
const { _internal } = require('../lib/init');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function cleanEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), ZN_STATS: 'off' };
  for (const v of AGENT_ENV_VARS) delete env[v];
  env.PATH = '';
  return env;
}

// Every file under the home, with its content. The zn-gate state folder is skipped.
function snapshot(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (p === path.join(dir, '.zn')) continue;
      if (e.isDirectory()) { out.push(p + '/'); walk(p); } else out.push(p + ':' + fs.readFileSync(p, 'utf8'));
    }
  })(dir);
  return out.sort();
}

const CURSOR = { mcpServers: { 'example-server': { command: 'node', args: ['example-server.js'] } } };
const CLAUDE = { mcpServers: { docs: { command: 'uvx', args: ['example-docs-server', '--root', '/srv/example'] }, remote: { url: 'https://mcp.example.com/sse' } } };

function setUpHome(t) {
  const home = tempDir(t, 'zn-init-s2e-home-');
  const cwd = tempDir(t, 'zn-init-s2e-cwd-');
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify(CURSOR, null, 2) + '\n');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(CLAUDE, null, 2) + '\n');
  return { home, cwd };
}

function runInit(home, cwd, args) {
  return spawnSync(process.execPath, [CLI, 'init', ...args], { cwd, env: cleanEnv(home), input: '', encoding: 'utf8', timeout: 60000 });
}

function read(home) {
  return {
    cursor: JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')),
    claude: JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')),
  };
}

function modifiedCount(stdout) {
  const m = /\((\d+) modified/.exec(stdout);
  return m ? Number(m[1]) : -1;
}

test('wrapperMode tells shadow from enforce and leaves other commands alone', () => {
  const { wrapperMode, enforceArgv } = _internal;
  assert.equal(wrapperMode(['npx', '-y', 'zn-gate', 'shield', '--shadow', '--', 'node', 's.js']), 'shadow');
  assert.equal(wrapperMode(['npx', '-y', 'zn-gate', 'shield', '--', 'node', 's.js']), 'enforce');
  // --shadow after the "--" belongs to the server command, not to the shield.
  assert.equal(wrapperMode(['npx', '-y', 'zn-gate', 'shield', '--', 'node', 's.js', '--shadow']), 'enforce');
  assert.equal(wrapperMode(['node', 's.js', 'shield', '--shadow', '--']), null);
  assert.equal(wrapperMode(['zn-mcp', 'serve']), null);
  assert.deepEqual(enforceArgv(['npx', '-y', 'zn-gate', 'shield', '--shadow', '--', 'node', 's.js', '--shadow']),
    ['npx', '-y', 'zn-gate', 'shield', '--', 'node', 's.js', '--shadow']);
});

test('init --wrap-mcp after init --shadow switches every shadow server to enforce and counts it as modified', (t) => {
  const { home, cwd } = setUpHome(t);
  const sh = runInit(home, cwd, ['--shadow']);
  assert.equal(sh.status, 0, sh.stderr + sh.stdout);
  let cfg = read(home);
  assert.deepEqual(cfg.cursor.mcpServers['example-server'].args, ['-y', 'zn-gate', 'shield', '--shadow', '--', 'node', 'example-server.js']);
  assert.ok(cfg.claude.mcpServers.docs.args.includes('--shadow'));

  const en = runInit(home, cwd, ['--wrap-mcp']);
  assert.equal(en.status, 0, en.stderr + en.stdout);
  assert.match(en.stdout, /switched from shadow to enforce: example-server/);
  assert.match(en.stdout, /switched from shadow to enforce: docs/);
  assert.doesNotMatch(en.stdout, /already_shielded/);
  assert.equal(modifiedCount(en.stdout), 2, en.stdout);
  cfg = read(home);
  assert.deepEqual(cfg.cursor.mcpServers['example-server'], { command: 'npx', args: ['-y', 'zn-gate', 'shield', '--', 'node', 'example-server.js'] });
  assert.deepEqual(cfg.claude.mcpServers.docs.args, ['-y', 'zn-gate', 'shield', '--', 'uvx', 'example-docs-server', '--root', '/srv/example']);
  assert.deepEqual(cfg.claude.mcpServers.remote, CLAUDE.mcpServers.remote);
  // The switch adds no backup: there is still one per config, the one from before zn wrapped it.
  assert.equal(fs.readdirSync(path.join(home, '.cursor')).filter((f) => f.startsWith('mcp.json.bak.')).length, 1);

  // Idempotent: a second run on enforced servers changes nothing.
  const before = snapshot(home);
  const again = runInit(home, cwd, ['--wrap-mcp']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already_shielded/);
  assert.doesNotMatch(again.stdout, /switched/);
  assert.equal(modifiedCount(again.stdout), 0);
  assert.deepEqual(snapshot(home), before);
});

test('init --wrap-mcp --dry-run shows the planned switch and changes no file', (t) => {
  const { home, cwd } = setUpHome(t);
  assert.equal(runInit(home, cwd, ['--shadow']).status, 0);
  const before = snapshot(home);
  const dry = runInit(home, cwd, ['--wrap-mcp', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would_switch_to_enforce/);
  assert.match(dry.stdout, /would switch from shadow to enforce: example-server/);
  assert.equal(modifiedCount(dry.stdout), 0);
  assert.deepEqual(snapshot(home), before);
});

test('init --shadow on servers that already enforce is refused with exit 2 and changes no file', (t) => {
  const { home, cwd } = setUpHome(t);
  assert.equal(runInit(home, cwd, ['--wrap-mcp']).status, 0);
  const before = snapshot(home);
  for (const args of [['--shadow'], ['--shadow', '--dry-run'], ['--wrap-mcp', '--shadow']]) {
    const r = runInit(home, cwd, args);
    assert.equal(r.status, 2, args.join(' ') + ': ' + r.stderr + r.stdout);
    assert.match(r.stderr, /--shadow would stop blocking on servers that already enforce: /);
    assert.match(r.stderr, /example-server \(Cursor\)/);
    assert.match(r.stderr, /zn-gate init --revert/);
    assert.deepEqual(snapshot(home), before);
  }
});

test('init --revert after the switch puts back the config from before zn wrapped it', (t) => {
  const { home, cwd } = setUpHome(t);
  assert.equal(runInit(home, cwd, ['--shadow']).status, 0);
  assert.equal(runInit(home, cwd, ['--wrap-mcp']).status, 0);
  const rev = runInit(home, cwd, ['--revert']);
  assert.equal(rev.status, 0, rev.stderr + rev.stdout);
  assert.match(rev.stdout, /\[reverted\]/);
  const cfg = read(home);
  assert.deepEqual(cfg.cursor, CURSOR);
  assert.deepEqual(cfg.claude, CLAUDE);
  // After the revert, shadow mode can be chosen again.
  const sh = runInit(home, cwd, ['--shadow']);
  assert.equal(sh.status, 0, sh.stderr);
  assert.ok(read(home).cursor.mcpServers['example-server'].args.includes('--shadow'));
});

test('a new server added after init --shadow is wrapped in enforce mode with the shadow ones switched', (t) => {
  const { home, cwd } = setUpHome(t);
  assert.equal(runInit(home, cwd, ['--shadow']).status, 0);
  const file = path.join(home, '.cursor', 'mcp.json');
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  cur.mcpServers['second-server'] = { command: 'node', args: ['second.js'] };
  fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n');
  const r = runInit(home, cwd, ['--wrap-mcp']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /switched from shadow to enforce: example-server/);
  const out = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers;
  assert.deepEqual(out['example-server'].args, ['-y', 'zn-gate', 'shield', '--', 'node', 'example-server.js']);
  assert.deepEqual(out['second-server'].args, ['-y', 'zn-gate', 'shield', '--', 'node', 'second.js']);
});

test('Codex config.toml and OpenCode: shadow wrappers switch to enforce; --shadow on enforced servers is refused', (t) => {
  const { configureEnvironments } = require('../lib/init');
  const dir = tempDir(t, 'zn-init-s2e-formats-');
  const toml = path.join(dir, 'config.toml');
  const original = ['[mcp_servers.example]', 'command = "uvx"', 'args = ["example-server"]', '', '[mcp_servers.example.env]', 'EXAMPLE_KEY = "fake-value"', ''].join('\n');
  fs.writeFileSync(toml, original);
  const oc = path.join(dir, 'opencode.json');
  const ocOriginal = { mcp: { local1: { type: 'local', command: ['node', 'example.js'] } } };
  fs.writeFileSync(oc, JSON.stringify(ocOriginal, null, 2) + '\n');
  const envList = [
    { name: 'Codex', id: 'codex', filePath: toml, key: 'mcp_servers', format: 'codex-toml' },
    { name: 'OpenCode', id: 'opencode', filePath: oc, key: 'mcp', format: 'opencode-json' },
  ];

  assert.ok(configureEnvironments({ envList, shadow: true }).actions.every((a) => a.status === 'shielded'));
  assert.ok(fs.readFileSync(toml, 'utf8').includes('args = ["-y", "zn-gate", "shield", "--shadow", "--", "uvx", "example-server"]'));

  const dry = configureEnvironments({ envList, dryRun: true });
  assert.deepEqual(dry.actions.map((a) => a.status), ['would_switch_to_enforce', 'would_switch_to_enforce']);
  assert.ok(fs.readFileSync(toml, 'utf8').includes('"--shadow"'));

  const sw = configureEnvironments({ envList });
  assert.deepEqual(sw.actions.map((a) => [a.status, a.switched]), [['switched_to_enforce', ['example']], ['switched_to_enforce', ['local1']]]);
  const tomlOut = fs.readFileSync(toml, 'utf8');
  assert.ok(tomlOut.includes('args = ["-y", "zn-gate", "shield", "--", "uvx", "example-server"]'));
  assert.ok(tomlOut.includes('[mcp_servers.example.env]\nEXAMPLE_KEY = "fake-value"'));
  assert.deepEqual(JSON.parse(fs.readFileSync(oc, 'utf8')).mcp.local1.command, ['npx', '-y', 'zn-gate', 'shield', '--', 'node', 'example.js']);

  assert.deepEqual(configureEnvironments({ envList }).actions.map((a) => a.status), ['already_shielded', 'already_shielded']);

  const refused = configureEnvironments({ envList, shadow: true });
  assert.equal(refused.refused.reason, 'enforced');
  assert.deepEqual(refused.refused.servers, [{ env: 'Codex', server: 'example' }, { env: 'OpenCode', server: 'local1' }]);
  assert.equal(refused.actions.length, 0);
  assert.ok(!fs.readFileSync(toml, 'utf8').includes('"--shadow"'));

  assert.ok(configureEnvironments({ envList, revert: true }).actions.every((a) => a.status === 'reverted'));
  assert.equal(fs.readFileSync(toml, 'utf8'), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(oc, 'utf8')), ocOriginal);
});
