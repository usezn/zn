'use strict';
// Keeps server.json (the MCP registry entry) in step with package.json and docs/cli.md.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pkgDir = path.resolve(__dirname, '..');
const repo = path.resolve(pkgDir, '..', '..');
const server = JSON.parse(fs.readFileSync(path.join(pkgDir, 'server.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const cliDocPath = path.join(repo, 'docs', 'cli.md');

test('server.json top-level version matches package.json', () => {
  assert.strictEqual(server.version, pkg.version);
});

test('server.json package version matches package.json', () => {
  assert.strictEqual(server.packages[0].version, pkg.version);
});

test('server.json package identifier is the package name', () => {
  assert.strictEqual(server.packages[0].identifier, pkg.name);
});

test('server.json name equals mcpName in package.json', () => {
  assert.ok(pkg.mcpName);
  assert.strictEqual(server.name, pkg.mcpName);
});

test('server.json repository subfolder is this package', () => {
  assert.strictEqual(server.repository.subfolder, 'packages/zn-gate');
});

test('every environment variable in server.json is documented in docs/cli.md', { skip: !fs.existsSync(cliDocPath) && 'repository docs not in this checkout' }, () => {
  const doc = fs.readFileSync(cliDocPath, 'utf8');
  const vars = server.packages[0].environmentVariables.map((v) => v.name);
  assert.ok(vars.length > 0);
  for (const name of vars) {
    const row = doc.split('\n').some((l) => l.startsWith('|') && l.includes('`' + name));
    assert.ok(row, name + ' is not in a table row of docs/cli.md');
  }
});
