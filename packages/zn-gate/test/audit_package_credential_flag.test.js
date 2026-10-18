'use strict';
// ZNA005 names the package an MCP server runs. The word after a credential flag (--password, --token,
// --api-key, --client-secret ...) is that flag's value, never the package: it must not be reported as one,
// and it must not appear in the text, JSON or SARIF report.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');
const P = require('../lib/audit/patterns');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const V = (n) => 'zn-test-fake-value-' + n;

function cli(args) {
  const env = Object.assign({}, process.env, { NO_COLOR: '1', ZN_LOCAL_ONLY: 'true' });
  return spawnSync(process.execPath, [CLI, 'audit', ...args], { encoding: 'utf8', env });
}

test('packagesOf: the package is the real one around credential flags', () => {
  const cases = [
    [['npx', '--password', V(1), 'some-pkg'], 'some-pkg'],
    [['npx', '-y', '--token', V(1), 'some-pkg'], 'some-pkg'],
    [['npx', '--api-key=' + V(1), 'some-pkg'], 'some-pkg'],
    [['npx', '--api-key', V(1), 'some-pkg'], 'some-pkg'],
    [['npx', '--client-secret', V(1), 'some-pkg'], 'some-pkg'],
    [['npx', '--auth-token', V(1), '--password', V(2), 'some-pkg'], 'some-pkg'],
    [['npx', 'some-pkg', '--password', V(1)], 'some-pkg'],
    [['npx', '-y', 'some-pkg@1.0.0', '--token', V(1)], 'some-pkg@1.0.0'],
    [['npx', '--package', 'real-pkg', '--password', V(1), 'bin-name'], 'real-pkg'],
    [['uvx', '--password', V(1), 'some-pkg'], 'some-pkg'],
    [['docker', 'run', '--password', V(1), 'example/image'], 'example/image'],
    [['npx', '--no-auth', 'some-pkg'], 'some-pkg'],
  ];
  for (const [argv, spec] of cases) {
    const pk = P.packagesOf(argv);
    assert.equal(pk.length, 1, argv.join(' '));
    assert.equal(pk[0].spec, spec, argv.join(' '));
  }
});

const CONFIG = `{"mcpServers": {
  "a": {"command": "npx", "args": ["--password", "${V(1)}", "pkg-a"]},
  "b": {"command": "npx", "args": ["-y", "--token", "${V(2)}", "pkg-b"]},
  "c": {"command": "npx", "args": ["--api-key=${V(3)}", "pkg-c"]},
  "d": {"command": "npx", "args": ["pkg-d", "--password", "${V(4)}"]},
  "e": {"command": "npx -y --password ${V(5)} pkg-e"},
  "f": {"command": "uvx", "args": ["--password", "${V(6)}", "pkg-f"]},
  "g": {"command": "npx", "args": ["--client-secret", "${V(7)}", "pkg-g"]},
  "h": {"command": "npx", "args": ["--auth", "${V(8)}", "pkg-h"]}
}}
`;

test('audit: ZNA005 reports the package and never a credential value', (t) => {
  const dir = tempDir(t, 'zn-audit-credflag-');
  fs.writeFileSync(path.join(dir, '.mcp.json'), CONFIG);
  const text = cli([dir, '--fail-on', 'none']).stdout;
  const json = cli([dir, '--format', 'json', '--fail-on', 'none']).stdout;
  const sarif = cli([dir, '--format', 'sarif', '--fail-on', 'none']).stdout;
  for (const out of [text, json, sarif]) {
    assert.ok(!out.includes('fake-value'), 'a value after a credential flag was printed');
  }
  const found = JSON.parse(json).findings.filter((f) => f.id === 'ZNA005').map((f) => f.detail);
  for (const name of ['a', 'b', 'c', 'd', 'e', 'g', 'h']) {
    assert.ok(found.some((d) => d.includes('"' + name + '" runs pkg-' + name + ' through npx')), 'package of ' + name + ': ' + found.join(' | '));
  }
  assert.ok(found.some((d) => d.includes('"f" runs pkg-f through uvx')));
});
