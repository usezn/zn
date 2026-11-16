'use strict';

// Strict JSON reading (OpenCode config) and TOML string reading (Codex config), through the public scan
// and the exported TOML scanner. All names, commands and paths are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanEnvironments, _internal } = require('../lib/init');

const { scanCodexToml } = _internal;

function scanOpencode(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-json-'));
  try {
    const filePath = path.join(dir, 'opencode.json');
    fs.writeFileSync(filePath, text);
    const env = { name: 'Example', id: 'example', filePath, key: 'mcp', format: 'opencode-json' };
    return scanEnvironments([env])[0];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const GOOD = '{"mcp":{"demo":{"type":"local","command":["example-server","--flag"]}}}';

test('strict JSON - plain valid text lists the server', () => {
  const r = scanOpencode(GOOD);
  assert.equal(r.serverCount, 1);
  assert.equal(r.servers[0].name, 'demo');
  assert.equal(r.servers[0].command, 'example-server');
  assert.deepEqual(r.servers[0].args, ['--flag']);
});

test('strict JSON - a trailing comma is reported as not strict JSON', () => {
  const r = scanOpencode('{"mcp":{"demo":{"type":"local","command":["example-server"],}}}');
  assert.equal(r.serverCount, 0);
  assert.equal(r.servers.length, 1);
  assert.match(r.servers[0].error, /opencode\.json is not strict JSON/);
  assert.match(r.servers[0].error, /Not rewriting it/);
});

test('strict JSON - a comment is reported as not strict JSON', () => {
  const r = scanOpencode('{\n  // example note\n  "mcp": {}\n}\n');
  assert.equal(r.serverCount, 0);
  assert.match(r.servers[0].error, /is not strict JSON/);
  const block = scanOpencode('{ /* note */ "mcp": {} }');
  assert.match(block.servers[0].error, /is not strict JSON/);
});

test('strict JSON - a byte order mark at the start is reported as not strict JSON', () => {
  const r = scanOpencode('\uFEFF' + GOOD);
  assert.equal(r.serverCount, 0);
  assert.match(r.servers[0].error, /is not strict JSON/);
});

function scanToml(lines) {
  return scanCodexToml(lines.join('\n')).servers;
}

test('TOML basic string - escapes are decoded', () => {
  const [s] = scanToml([
    '[mcp_servers.demo]',
    'command = "C:\\\\tools\\\\example \\"x\\"\\ttab"',
  ]);
  assert.equal(s.command, 'C:\\tools\\example "x"\ttab');
  assert.equal(s.unsupported, null);
});

test('TOML basic string - a unicode escape is decoded', () => {
  const [s] = scanToml(['[mcp_servers.demo]', 'command = "caf\\u00e9"']);
  assert.equal(s.command, 'caf\u00e9');
});

test('TOML basic string - an escape JSON does not know makes the command unsupported', () => {
  const [s] = scanToml(['[mcp_servers.demo]', 'command = "a\\qb"']);
  assert.equal(s.command, null);
  assert.equal(s.unsupported, 'command is not a single-line string');
});

test('TOML literal string - backslashes are kept as they are', () => {
  const [s] = scanToml(['[mcp_servers.demo]', "command = 'C:\\tools\\example\\n'"]);
  assert.equal(s.command, 'C:\\tools\\example\\n');
});

test('TOML literal string - a double quote inside is kept', () => {
  const [s] = scanToml(['[mcp_servers.demo]', `command = 'say "hi"'`]);
  assert.equal(s.command, 'say "hi"');
});

test('TOML strings - a trailing comment is allowed, other trailing text is not', () => {
  const [a, b] = scanToml([
    '[mcp_servers.a]',
    `command = 'example' # note`,
    '[mcp_servers.b]',
    `command = "example" extra`,
  ]);
  assert.equal(a.command, 'example');
  assert.equal(b.command, null);
  assert.equal(b.unsupported, 'command is not a single-line string');
});

test('TOML strings - multi-line and unterminated strings are unsupported', () => {
  const servers = scanToml([
    '[mcp_servers.a]',
    'command = """example"""',
    '[mcp_servers.b]',
    "command = '''example'''",
    '[mcp_servers.c]',
    'command = "example',
  ]);
  assert.equal(servers.length, 3);
  for (const s of servers) {
    assert.equal(s.command, null);
    assert.equal(s.unsupported, 'command is not a single-line string');
  }
});
