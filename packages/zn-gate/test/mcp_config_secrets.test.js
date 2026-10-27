'use strict';
// Credentials written in plain text in MCP server configs: the shared samples
// (also run by the Python package), `zn-gate scan` on the config files of each
// agent, the output formats, the user's own configs, `zn audit` (ZNA011), and
// speed on large and hostile files. Every value is invented and assembled at
// run time; no output may contain it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');
const { audit } = require('../lib/audit');
const mcp = require('../lib/mcp-secrets');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const SAMPLES = path.join(__dirname, 'fixtures', 'mcp_config_secret_samples.json');
const FAKE = 'ZNTESTFAKE' + 'q8v3Lm9x2W';
const NEEDLES = ['ZNTESTFAKE', 'q8v3Lm9x2W'];
const KEY = 'sk-ant-api03-' + 'ZNTESTFAKE' + 'q8v3Lm9x2W'.repeat(8);

function expand(text) {
  return text.split('{V}').join(FAKE);
}

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function scan(dir, args = [], env = {}) {
  return spawnSync(process.execPath, [CLI, 'scan', dir, ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, ZN_LOCAL_ONLY: 'true', ...env }, maxBuffer: 64 * 1024 * 1024,
  });
}

function scanJson(dir, args = [], env = {}) {
  const r = scan(dir, ['--format', 'json', ...args], env);
  return { status: r.status, data: JSON.parse(r.stdout), out: r.stdout + r.stderr };
}

function noValue(text, what) {
  for (const n of NEEDLES) assert.ok(!text.includes(n), `${what}: a value was printed`);
}

const MCP_JSON = expand(`{
  "mcpServers": {
    "search": {
      "command": "npx",
      "args": ["-y", "pkg@1.2.3", "--api-key", "{V}"],
      "env": { "BRAVE_API_KEY": "{V}", "LOG_LEVEL": "debug" }
    },
    "remote": {
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer {V}" }
    }
  }
}
`);

test('shared samples: each credential is found at its line, with its kind and name', () => {
  const { cases, paths } = JSON.parse(fs.readFileSync(SAMPLES, 'utf8'));
  assert.ok(cases.length >= 8);
  for (const c of cases) {
    const got = mcp.findMcpConfigSecrets(expand(c.lines.join('\n')), { file: c.file || '' }).map((f) => [f.line, f.kind, f.name]);
    assert.deepEqual(got, c.expect, c.name);
  }
  for (const p of paths) {
    assert.equal(mcp.isMcpConfigPath(p.path), p.mcp, JSON.stringify(p.path));
  }
});

test('results hold the kind, the name and the line, never the value', () => {
  for (const f of mcp.findMcpConfigSecrets(MCP_JSON)) {
    const text = JSON.stringify(f) + mcp.mcpSample(f.kind, f.name) + mcp.mcpNextStep(f.kind, f.name) + mcp.mcpReason(f.kind);
    noValue(text, 'result');
  }
});

test('which files are MCP configs', () => {
  for (const f of ['.mcp.json', 'a/b/.cursor/mcp.json', '.vscode/mcp.json', 'claude_desktop_config.json', 'x/mcp_config.json', '.codex/config.toml', '.gemini/settings.json', 'opencode.jsonc', 'C:\\Users\\u\\.claude.json']) {
    assert.equal(mcp.isMcpConfigPath(f), true, f);
  }
  for (const f of ['config.toml', 'settings.json', '.vscode/settings.json', 'package.json', 'mcp.json.bak', 'notes.md']) {
    assert.equal(mcp.isMcpConfigPath(f), false, f);
  }
});

test('the suggested variable name says what the value is for', () => {
  assert.equal(mcp.suggestedName(mcp.normalizeName('BRAVE_API_KEY')), 'BRAVE_API_KEY');
  assert.equal(mcp.suggestedName(mcp.normalizeName('Authorization')), 'MCP_AUTHORIZATION');
  assert.equal(mcp.suggestedName(mcp.normalizeName('token')), 'MCP_TOKEN');
  assert.equal(mcp.suggestedName(mcp.normalizeName('githubPersonalAccessToken')), 'GITHUB_PERSONAL_ACCESS_TOKEN');
  assert.match(mcp.suggestedName('1_x'), /^MCP_/);
});

for (const file of ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', 'claude_desktop_config.json', '.gemini/antigravity/mcp_config.json', 'cline_mcp_settings.json']) {
  test(`scan reports credentials in ${file} by type, file and line`, (t) => {
    const dir = tempDir(t, 'zn-mcp-scan-');
    write(dir, { [file]: MCP_JSON });
    const { status, data, out } = scanJson(dir);
    assert.equal(status, 1);
    noValue(out, file);
    const lines = new Set(data.threats.filter((x) => x.type === 'secret_leak').map((x) => x.line));
    for (const n of [5, 6, 10]) assert.ok(lines.has(n), `line ${n} reported in ${file}`);
    assert.ok(!lines.has(1) && !lines.has(7), 'no finding on a line without a credential');
    for (const th of data.threats) {
      assert.equal(th.file.split(path.sep).join('/'), file);
      assert.ok(th.next_step && /^Next: /.test(th.next_step));
    }
    // The line with only the credential flag and its value is the rule of this check.
    const flagLine = data.threats.find((x) => x.line === 5);
    assert.equal(flagLine.rule, 'secret:mcp_config');
  });
}

test('the .codex/config.toml of a project is checked', (t) => {
  const dir = tempDir(t, 'zn-mcp-toml-');
  write(dir, {
    '.codex/config.toml': expand('[mcp_servers.x]\ncommand = "npx"\n[mcp_servers.x.http_headers]\nAuthorization = "Bearer {V}"\n[mcp_servers.x.env]\nLOG_LEVEL = "debug"\n'),
  });
  const { status, data, out } = scanJson(dir);
  assert.equal(status, 1);
  noValue(out, 'toml');
  assert.deepEqual(data.threats.map((x) => [x.line, x.rule]), [[4, 'secret:mcp_config']]);
});

test('references, placeholders and plain settings keep a config clean', (t) => {
  const dir = tempDir(t, 'zn-mcp-clean-');
  write(dir, {
    '.mcp.json': JSON.stringify({
      mcpServers: {
        a: { command: 'npx', args: ['-y', 'pkg@1.2.3', '--api-key', '${API_KEY}', '--port', '8080'], env: { BRAVE_API_KEY: '${BRAVE_API_KEY}', LOG_LEVEL: 'debug', STRIPE_KEY: '__ZN_STRIPE_KEY__' } },
        b: { url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer ${TOKEN}' } },
      },
    }, null, 2),
  });
  const { status, data } = scanJson(dir);
  assert.equal(status, 0, JSON.stringify(data.threats));
  assert.equal(data.total_secrets, 0);
});

test('a file with another name is not treated as an MCP config', (t) => {
  const dir = tempDir(t, 'zn-mcp-other-');
  write(dir, { 'servers.json': MCP_JSON, '.vscode/settings.json': MCP_JSON });
  const { data } = scanJson(dir);
  assert.ok(!data.threats.some((x) => x.rule === 'secret:mcp_config'));
  assert.equal(data.total_files, 1, '.vscode/settings.json is not scanned');
});

test('a value never reaches another rule snippet on the same line', (t) => {
  const V2 = 'ZNTESTFAKE' + 'x7Pq4Rt8Yu1';
  const multi = '{\n  "mcpServers": { "s": { "command": "npx",\n    "args": ["-y", "x", "--api-key", "' + FAKE + '", "--token=' + V2 + '"] } }\n}\n';
  const single = '{"mcpServers":{"b":{"command":"npx","env":{"API_KEY":"x"},"args":["--password","' + FAKE + '","--token=' + V2 + '"]}}}';
  for (const [name, text] of [['multi-line', multi], ['single line', single]]) {
    const dir = tempDir(t, 'zn-mcp-snip-');
    write(dir, { '.mcp.json': text });
    for (const fmt of [[], ['--format', 'json'], ['--format', 'github']]) {
      const r = scan(dir, fmt);
      noValue(r.stdout + r.stderr, name + ' ' + fmt.join(' '));
    }
    const { data } = scanJson(dir);
    const names = data.threats.filter((x) => x.rule === 'secret:mcp_config').map((x) => x.content);
    assert.equal(names.length, 2, name + ': ' + JSON.stringify(names));
  }
});

test('a credential another rule also knows is one finding, as secret:mcp_config with the MCP next step', (t) => {
  const dir = tempDir(t, 'zn-mcp-step-');
  write(dir, { '.mcp.json': '{\n  "mcpServers": { "s": { "env": {\n    "GITHUB_TOKEN": "ghp_' + 'ZNTESTFAKE' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5" }\n  } } }\n' });
  const { data, out } = scanJson(dir);
  noValue(out, 'provider key');
  const hits = data.threats.filter((x) => x.line === 3);
  assert.equal(hits.length, 1);
  assert.match(hits[0].next_step, /zn-gate secret set GITHUB_TOKEN/);
});

test('the key Claude Code logs in with is left alone in ~/.claude.json', () => {
  const text = '{ "primaryApiKey": "' + FAKE + '", "mcpServers": { "s": { "env": { "BRAVE_API_KEY": "' + FAKE + '" } } } }';
  assert.deepEqual(mcp.findMcpConfigSecrets(text, { file: '/home/u/.claude.json' }).map((f) => f.name), ['BRAVE_API_KEY']);
  assert.deepEqual(mcp.findMcpConfigSecrets(text, { file: 'other.json' }).map((f) => f.name), ['primaryApiKey', 'BRAVE_API_KEY']);
});

test('--include-home follows a symbolic link inside the home folder and not one that leaves it', (t) => {
  if (process.platform === 'win32') { t.skip('symbolic links need privileges on Windows'); return; }
  const home = tempDir(t, 'zn-mcp-link-');
  const outside = tempDir(t, 'zn-mcp-outside-');
  const empty = tempDir(t, 'zn-mcp-linkempty-');
  write(home, { 'dotfiles/cursor.json': MCP_JSON });
  write(outside, { 'mcp.json': MCP_JSON });
  fs.mkdirSync(path.join(home, '.cursor'));
  fs.symlinkSync(path.join(home, 'dotfiles', 'cursor.json'), path.join(home, '.cursor', 'mcp.json'));
  fs.symlinkSync(path.join(outside, 'mcp.json'), path.join(home, '.claude.json'));
  const env = { HOME: home, USERPROFILE: home, CODEX_HOME: '', XDG_CONFIG_HOME: '', APPDATA: '' };
  const { data } = scanJson(empty, ['--include-home'], env);
  const files = new Set(data.threats.map((x) => x.file));
  assert.ok(files.has('~/.cursor/mcp.json'));
  assert.ok(!files.has('~/.claude.json'));
});

test('text and github output never show the value', (t) => {
  const dir = tempDir(t, 'zn-mcp-fmt-');
  write(dir, { '.mcp.json': MCP_JSON });
  const text = scan(dir);
  assert.equal(text.status, 1);
  noValue(text.stdout + text.stderr, 'text');
  assert.match(text.stdout, /Secret found/);
  assert.match(text.stdout, /secret:mcp_config/);
  assert.match(text.stdout, /Plaintext credential in an MCP server configuration/);
  const gh = scan(dir, ['--format', 'github']);
  noValue(gh.stdout + gh.stderr, 'github');
  assert.match(gh.stdout, /::error file=\.mcp\.json,line=5,title=Secret found \(secret%3Amcp_config\)::Next: /);
});

test('the next step is plain: the vault and zn run --secrets for env and arguments, an environment variable for headers', () => {
  const env = mcp.mcpNextStep('environment variable', 'BRAVE_API_KEY');
  assert.match(env, /npx -y zn-gate secret set BRAVE_API_KEY/);
  assert.match(env, /put run, --secrets, BRAVE_API_KEY, -- and the old command first in args/);
  assert.match(env, /environment variable BRAVE_API_KEY/);
  assert.doesNotMatch(env, /put __ZN_/);
  assert.match(env, /rotate/);
  const arg = mcp.mcpNextStep('argument', 'api-key');
  assert.match(arg, /put run, --secrets, MCP_API_KEY, -- and the old command first in args/);
  assert.match(arg, /a __ZN_MCP_API_KEY__ marker written in args is not filled in, because arguments are visible to other processes/);
  assert.match(arg, /rotate/);
  const header = mcp.mcpNextStep('header', 'Authorization');
  assert.match(header, /environment variable/);
  assert.match(header, /\$\{MCP_AUTHORIZATION\}/);
  assert.doesNotMatch(header, /secret set/);
});

test('--include-home also checks the user own MCP configs, shown as ~/', (t) => {
  const home = tempDir(t, 'zn-mcp-home-');
  const empty = tempDir(t, 'zn-mcp-empty-');
  write(home, { '.cursor/mcp.json': MCP_JSON, '.codex/config.toml': expand('[mcp_servers.x.env]\nBRAVE_API_KEY = "{V}"\n') });
  const env = { HOME: home, USERPROFILE: home, CODEX_HOME: '', XDG_CONFIG_HOME: '', APPDATA: '' };
  const without = scanJson(empty, [], env);
  assert.equal(without.status, 3); // no file was read
  const withHome = scanJson(empty, ['--include-home'], env);
  assert.equal(withHome.status, 1);
  noValue(withHome.out, 'home');
  const files = new Set(withHome.data.threats.map((x) => x.file));
  assert.ok(files.has('~/.cursor/mcp.json'), [...files].join(','));
  assert.ok(files.has('~/.codex/config.toml'), [...files].join(','));
  assert.equal(withHome.data.total_files, 2);
});

test('zn audit reports the same credentials as ZNA011, with the fix and without the value', (t) => {
  const dir = tempDir(t, 'zn-mcp-audit-');
  write(dir, { '.mcp.json': MCP_JSON, '.vscode/mcp.json': MCP_JSON });
  const res = audit({ root: dir, agents: ['all'], env: {} });
  const hits = res.findings.filter((f) => f.id === 'ZNA011' && f.file === '.mcp.json');
  assert.deepEqual(hits.map((f) => f.line).sort((a, b) => a - b), [5, 6, 10]);
  for (const f of hits) {
    assert.equal(f.severity, 'high');
    noValue(JSON.stringify(f), 'audit finding');
  }
  assert.ok(res.findings.some((f) => f.id === 'ZNA011' && f.file === '.vscode/mcp.json'));
  const r = spawnSync(process.execPath, [CLI, 'audit', dir, '--format', 'sarif', '--fail-on', 'none'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  noValue(r.stdout + r.stderr, 'sarif');
  assert.match(r.stdout, /ZNA011/);
});

test('zn audit stays quiet about references in an MCP config', (t) => {
  const dir = tempDir(t, 'zn-mcp-audit-clean-');
  write(dir, { '.mcp.json': '{ "mcpServers": { "a": { "command": "node", "env": { "BRAVE_API_KEY": "${BRAVE_API_KEY}" } } } }\n' });
  const res = audit({ root: dir, agents: ['all'], env: {} });
  assert.ok(!res.findings.some((f) => f.id === 'ZNA011'));
});

function ms(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

test('large and hostile files are read in linear time', () => {
  const MB = 1024 * 1024;
  const inputs = {
    'many pairs': '{\n' + '  "A_TOKEN": "short",\n'.repeat(Math.floor(2 * MB / 22)) + '}\n',
    'many credentials': ('  "A_API_KEY": "' + FAKE + '",\n').repeat(Math.floor(2 * MB / 45)),
    'one long line of pairs': '{' + '"K": "v", '.repeat(Math.floor(2 * MB / 10)) + '}',
    'unterminated strings': ('"a:"b=" ' + "'x ").repeat(Math.floor(2 * MB / 14)),
    'backslashes': '"' + '\\'.repeat(2 * MB) + '"',
    'long bare words': 'a'.repeat(2 * MB) + ' = "x"',
    'flags without values': '"--token", \n'.repeat(Math.floor(2 * MB / 12)),
    'urls': ('"https://h/?k=' + 'a'.repeat(20) + '&", ').repeat(Math.floor(2 * MB / 40)),
    'one huge value': '{ "A_TOKEN": "' + 'x'.repeat(2 * MB) + '" }',
  };
  for (const [name, text] of Object.entries(inputs)) {
    const took = ms(() => mcp.findMcpConfigSecrets(text));
    assert.ok(took < 8000, `${name}: ${Math.round(took)} ms`);
  }
});

test('scan stays fast on a large MCP config file', (t) => {
  const dir = tempDir(t, 'zn-mcp-big-');
  write(dir, { '.mcp.json': '{\n' + '  "A_TOKEN": "short",\n'.repeat(60000) + '}\n' });
  const t0 = Date.now();
  const r = scan(dir, ['--format', 'json']);
  assert.ok(r.status === 0 || r.status === 1);
  assert.ok(Date.now() - t0 < 60000);
});

test('a second credential on a line another rule reports is still found', (t) => {
  const dir = tempDir(t, 'zn-mcp-two-');
  write(dir, { '.mcp.json': '{ "mcpServers": { "s": { "env": { "GITHUB_TOKEN": "ghp_' + 'ZNTESTFAKE' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5", "DB_PASSWORD": "' + FAKE + '" } } } }\n' });
  const { data, out } = scanJson(dir);
  noValue(out, 'two credentials');
  assert.equal(data.threats.filter((x) => x.line === 1).length, 2);
});

test('only .vscode/mcp.json is read in the .vscode folder', (t) => {
  const dir = tempDir(t, 'zn-mcp-vscode-');
  write(dir, { '.vscode/mcp.json': MCP_JSON, '.vscode/sub/conf.json': MCP_JSON, '.vscode/launch.json': MCP_JSON });
  const { data } = scanJson(dir);
  assert.equal(data.total_files, 1);
  assert.ok(data.threats.every((x) => x.file.split(path.sep).join('/') === '.vscode/mcp.json'));
});

test('a home .claude.json over 2 MiB is checked for MCP credentials only', (t) => {
  const home = tempDir(t, 'zn-mcp-bighome-');
  const empty = tempDir(t, 'zn-mcp-bigempty-');
  const padding = '  "history": "ordinary text that is not a credential",\n'.repeat(60000);
  write(home, { '.claude.json': '{\n' + padding + '  "mcpServers": { "s": { "env": { "BRAVE_API_KEY": "' + FAKE + '" } } }\n}\n' });
  const env = { HOME: home, USERPROFILE: home, CODEX_HOME: '', XDG_CONFIG_HOME: '', APPDATA: '' };
  const { data, out } = scanJson(empty, ['--include-home'], env);
  noValue(out, 'big home file');
  assert.equal(data.total_skipped, 0);
  assert.deepEqual(data.threats.map((x) => [x.file, x.rule]), [['~/.claude.json', 'secret:mcp_config']]);
});

test('a suggested name never ends with an underscore', () => {
  assert.ok(!/_$/.test(mcp.suggestedName(mcp.normalizeName('a'.repeat(55) + '_token'))));
});

test('~/.claude.json: the login key is not a finding of any rule, in a small file too', (t) => {
  const home = tempDir(t, 'zn-mcp-login-');
  const empty = tempDir(t, 'zn-mcp-loginempty-');
  write(home, { '.claude.json': '{\n  "primaryApiKey": "' + KEY + '",\n  "mcpServers": { "s": { "env": { "BRAVE_API_KEY": "' + FAKE + '" } } }\n}\n' });
  const env = { HOME: home, USERPROFILE: home, CODEX_HOME: '', XDG_CONFIG_HOME: '', APPDATA: '' };
  const { data, out } = scanJson(empty, ['--include-home'], env);
  noValue(out, 'login key');
  assert.deepEqual(data.threats.map((x) => [x.line, x.rule]), [[3, 'secret:mcp_config']]);
});

test('--include-home does not follow a link on a parent folder out of home', (t) => {
  if (process.platform === 'win32') { t.skip('symbolic links need privileges on Windows'); return; }
  const home = tempDir(t, 'zn-mcp-dirlink-');
  const outside = tempDir(t, 'zn-mcp-dirout-');
  const empty = tempDir(t, 'zn-mcp-dirempty-');
  write(outside, { 'config.toml': '[mcp_servers.x.env]\nBRAVE_API_KEY = "' + FAKE + '"\n' });
  fs.symlinkSync(outside, path.join(home, '.codex'));
  const env = { HOME: home, USERPROFILE: home, CODEX_HOME: '', XDG_CONFIG_HOME: '', APPDATA: '' };
  const { data } = scanJson(empty, ['--include-home'], env);
  assert.equal(data.threats.length, 0);
});
