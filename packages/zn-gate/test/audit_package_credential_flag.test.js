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
    [['npx', '--auth_token', V(1), 'some-pkg'], 'some-pkg'],
    [['npx', '--github_token', V(1), 'some-pkg'], 'some-pkg'],
    [['npx', '--_authToken', V(1), 'some-pkg'], 'some-pkg'],
    [['npx', '--//registry.npmjs.org/:_authToken', V(1), 'some-pkg'], 'some-pkg'],
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
  "h": {"command": "npx", "args": ["--auth", "${V(8)}", "pkg-h"]},
  "i": {"command": "npx", "args": ["--auth_token", "${V(9)}", "pkg-i"]},
  "j": {"command": "npx", "args": ["--github_token", "${V(10)}", "pkg-j"]},
  "k": {"command": "npx", "args": ["--_authToken", "${V(11)}", "pkg-k"]},
  "l": {"command": "npx", "args": ["--//registry.npmjs.org/:_authToken", "${V(12)}", "pkg-l"]},
  "m": {"command": "npx --auth_token ${V(13)} pkg-m"}
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
  for (const name of ['a', 'b', 'c', 'd', 'e', 'g', 'i', 'j', 'k', 'l', 'm']) {
    assert.ok(found.some((d) => d.includes('"' + name + '" runs pkg-' + name + ' through npx')), 'package of ' + name + ': ' + found.join(' | '));
  }
  assert.ok(found.some((d) => d.includes('"f" runs pkg-f through uvx')));
});

test('a flag that looks like a credential flag cannot hide an unpinned package', (t) => {
  // --auth and --compat take no value, but are treated as credential flags: the package after them is not
  // named, yet it is still reported.
  for (const flag of ['--auth', '--secret', '--oauth', '--use-auth', '--require-auth', '--compat', '--hotkey']) {
    const pk = P.packagesOf(['npx', flag]);
    assert.deepEqual(pk, [], flag + ' with nothing after it');
    const hid = P.packagesOf(['npx', flag, 'some-pkg']);
    assert.equal(hid.length, 1, flag);
    assert.equal(hid[0].hidden, true, flag);
    assert.equal(hid[0].pinned, false, flag);
  }
  const dir = tempDir(t, 'zn-audit-credflag-hidden-');
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers": {"x": {"command": "npx", "args": ["--auth", "some-pkg"]}}}\n');
  const out = cli([dir, '--format', 'json', '--fail-on', 'none']).stdout;
  const d = JSON.parse(out).findings.filter((f) => f.id === 'ZNA005').map((f) => f.detail);
  assert.equal(d.length, 1);
  assert.match(d[0], /runs a package through npx without an exact version \(its name follows a credential flag and is not shown\)/);
});

// More credential flags, recognised by name: --passphrase, --bearer, --pass, --tokens, --keys, --jwt, --cookie.
const NEW_FLAGS = ['--passphrase', '--bearer', '--pass', '--tokens', '--keys', '--jwt', '--cookie', '--access-tokens', '--user_pass'];

test('packagesOf: the newer credential flags do not hide the package', () => {
  for (const flag of NEW_FLAGS) {
    for (const tool of [['npx'], ['uvx'], ['docker', 'run']]) {
      const img = tool[0] === 'docker' ? 'example/image' : 'some-pkg';
      const pk = P.packagesOf([...tool, flag, V(1), img]);
      assert.equal(pk.length, 1, tool[0] + ' ' + flag);
      assert.equal(pk[0].spec, img, tool[0] + ' ' + flag);
      const eq = P.packagesOf([...tool, flag + '=' + V(1), img]);
      assert.equal(eq[0].spec, img, tool[0] + ' ' + flag + '=');
    }
  }
});

test('packagesOf: flags that only look like credential flags are not treated as one', () => {
  // These take no value, or are not credentials: the word after them is the package.
  for (const flag of ['--pass-through', '--pass_through', '--keys-only', '--bypass', '--compass', '--keep', '--cookies-from', '--passenger', '--license', '-t', '-k', '--keystore-type']) {
    assert.equal(P.isCredentialFlag(flag), false, flag);
    const pk = P.packagesOf(['npx', flag, 'some-pkg']);
    assert.equal(pk.length, 1, flag);
    assert.equal(pk[0].spec, 'some-pkg', flag);
    assert.ok(!pk[0].hidden, flag);
  }
  for (const flag of NEW_FLAGS) assert.equal(P.isCredentialFlag(flag), true, flag);
});

const CONFIG2 = `{"mcpServers": {
  "a": {"command": "npx", "args": ["--passphrase", "${V(21)}", "pkg-a"]},
  "b": {"command": "npx", "args": ["--bearer", "${V(22)}", "pkg-b"]},
  "c": {"command": "npx", "args": ["--pass", "${V(23)}", "pkg-c"]},
  "d": {"command": "npx", "args": ["--tokens=${V(24)}", "pkg-d"]},
  "e": {"command": "npx", "args": ["--keys", "${V(25)}", "pkg-e"]},
  "f": {"command": "npx", "args": ["--jwt", "${V(26)}", "pkg-f"]},
  "g": {"command": "npx", "args": ["--cookie", "${V(27)}", "pkg-g"]},
  "h": {"command": "npx -y --passphrase ${V(28)} pkg-h"},
  "i": {"command": "npx --bearer ${V(29)} --jwt ${V(30)} pkg-i"},
  "j": {"command": "npx --cookie=${V(31)} pkg-j"},
  "k": {"command": "npx", "args": ["--pass-through", "pkg-k"]},
  "l": {"command": "npx", "args": ["--keys-only", "pkg-l"]},
  "m": {"command": "npx", "args": ["--access-tokens", "${V(32)}", "pkg-m"]},
  "n": {"command": "npx", "args": ["--user_pass", "${V(33)}", "pkg-n"]},
  "o": {"command": "npx", "args": ["--api-keys", "${V(34)}", "pkg-o"]},
  "p": {"command": "npx", "args": ["--my_jwt", "${V(35)}", "pkg-p"]},
  "q": {"command": "npx", "args": ["--user_pass=${V(36)}", "pkg-q"]},
  "r": {"command": "npx --session-cookie ${V(37)} pkg-r"},
  "s": {"command": "npx --user_pass ${V(38)} pkg-s"},
  "u": {"command": "npx", "args": ["--pass_through", "pkg-u"]}
}}
`;

test('audit: the newer credential flags never print their value', (t) => {
  const dir = tempDir(t, 'zn-audit-credflag2-');
  fs.writeFileSync(path.join(dir, '.mcp.json'), CONFIG2);
  const text = cli([dir, '--fail-on', 'none']).stdout;
  const json = cli([dir, '--format', 'json', '--fail-on', 'none']).stdout;
  const sarif = cli([dir, '--format', 'sarif', '--fail-on', 'none']).stdout;
  for (const out of [text, json, sarif]) {
    assert.ok(!out.includes('fake-value'), 'a value after a credential flag was printed');
  }
  const found = JSON.parse(json).findings.filter((f) => f.id === 'ZNA005').map((f) => f.detail);
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 'u']) {
    assert.ok(found.some((d) => d.includes('"' + name + '" runs pkg-' + name + ' through npx')), 'package of ' + name + ': ' + found.join(' | '));
  }
  // The server command in ZNA003 hides the value too, and still shows the flags that take no value.
  const z3 = JSON.parse(json).findings.filter((f) => f.id === 'ZNA003').map((f) => f.detail).join('\n');
  assert.match(z3, /--passphrase \[REDACTED\] pkg-h/);
  assert.match(z3, /--pass-through pkg-k|--pass-through/);
});

test('audit: the newer credential flags stay linear on hostile input', (t) => {
  const dir = tempDir(t, 'zn-audit-credflag2-linear-');
  for (const unit of ['--pass-', '--keys-', '--cookie ', '--jwt ', '--//a:']) {
    const big = unit.repeat(40000);
    P.packagesOf(['npx', big, 'x']);
    P.isCredentialFlag(big);
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers": {"x": {"command": "npx ' + big + ' pkg"}}}' + String.fromCharCode(10));
    const t0 = Date.now();
    cli([dir, '--format', 'json', '--fail-on', 'none']);
    assert.ok(Date.now() - t0 < 8000, unit + ' took ' + (Date.now() - t0) + ' ms');
  }
});
