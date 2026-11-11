'use strict';

// The stale-baseline hint (ZNA023) tells the person to run `zn audit --approve`.
// On Windows the bare `zn` picks the zn.ps1 shim, which the default PowerShell
// execution policy refuses, so the hint names `zn.cmd` there.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { main } = require('../lib/audit/cli');
const { tempDir } = require('./helpers/tmp');

async function asPlatform(value, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

async function run(args, io) {
  let out = '';
  let err = '';
  const code = await main(args, Object.assign({ stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, env: {}, stdin: { isTTY: true }, ancestry: () => null, accountVault: null }, io));
  return { code, out, err };
}

// Approve a baseline, change the config, and read the ZNA023 hint, all while pretending to be
// `platform`: the baseline file is keyed by a path that is lowercased on win32, so approve and
// check must run on the same platform to find each other's baseline.
async function staleHint(t, platform) {
  const dir = tempDir(t, 'zn-approve-hint-');
  const home = tempDir(t, 'zn-approve-hint-home-');
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { tools: { command: 'node', args: ['server.js'] } } }));
  const a = await asPlatform(platform, () => run([dir, '--approve'], { home }));
  assert.equal(a.code, 0);
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { tools: { command: 'node', args: ['changed.js'] } } }));
  const r = await asPlatform(platform, () => run([dir, '--format', 'json', '--fail-on', 'none'], { home }));
  const found = JSON.parse(r.out).findings.filter((x) => x.id === 'ZNA023');
  assert.equal(found.length, 1);
  return found[0].fix;
}

test('stale-baseline hint names zn.cmd audit --approve on win32', async (t) => {
  const fix = await staleHint(t, 'win32');
  assert.match(fix, /`zn\.cmd audit --approve`/);
  assert.doesNotMatch(fix, /`zn audit --approve`/);
});

test('stale-baseline hint names zn audit --approve on other platforms', async (t) => {
  const fix = await staleHint(t, 'linux');
  assert.match(fix, /`zn audit --approve`/);
  assert.doesNotMatch(fix, /zn\.cmd/);
});
