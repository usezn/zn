'use strict';

// `zn audit --approve` records the executable configuration; a later change is reported as ZNA023 without printing any value.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { main } = require('../lib/audit/cli');
const { tempDir } = require('./helpers/tmp');

function setup(t, mcp) {
  const dir = tempDir(t, 'zn-approve-');
  const home = tempDir(t, 'zn-approve-home-');
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { tools: mcp } }));
  return { dir, home };
}

async function run(args, io) {
  let out = '';
  let err = '';
  const code = await main(args, Object.assign({ stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, env: {} }, io));
  return { code, out, err };
}

test('without an approved baseline nothing is reported as changed', async (t) => {
  const { dir, home } = setup(t, { command: 'node', args: ['server.js'] });
  const r = await run([dir, '--format', 'json', '--fail-on', 'none'], { home });
  assert.ok(!JSON.parse(r.out).findings.some((f) => f.id === 'ZNA023'));
});

test('--approve records the entries and a later change is reported by name only', async (t) => {
  const { dir, home } = setup(t, { command: 'node', args: ['server.js'] });
  const a = await run([dir, '--approve'], { home });
  assert.equal(a.code, 0);
  assert.match(a.out, /recorded 1 executable configuration entry/);
  const same = await run([dir, '--format', 'json', '--fail-on', 'none'], { home });
  assert.ok(!JSON.parse(same.out).findings.some((f) => f.id === 'ZNA023'));
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { tools: { command: 'node', args: ['evil-marker-9.js'] } } }));
  const r = await run([dir, '--format', 'json', '--fail-on', 'none'], { home });
  const f = JSON.parse(r.out).findings.filter((x) => x.id === 'ZNA023');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'high');
  assert.match(f[0].detail, /mcp:tools/);
  assert.ok(!JSON.stringify(f).includes('evil-marker-9'));
  const gate = await run([dir, '--fail-on', 'high'], { home });
  assert.equal(gate.code, 1);
});

test('a reformat is not a change; an added entry is high and a removed one is low', async (t) => {
  const { dir, home } = setup(t, { command: 'node', args: ['server.js'] });
  await run([dir, '--approve'], { home });
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { tools: { args: ['server.js'], command: 'node' } } }, null, 4));
  let r = await run([dir, '--format', 'json', '--fail-on', 'none'], { home });
  assert.ok(!JSON.parse(r.out).findings.some((f) => f.id === 'ZNA023'));
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'node' } } }));
  r = await run([dir, '--format', 'json', '--fail-on', 'none'], { home });
  const sev = JSON.parse(r.out).findings.filter((x) => x.id === 'ZNA023').map((x) => x.severity).sort();
  assert.deepEqual(sev, ['high', 'low']);
});

test('a damaged baseline file is ignored and never stops the audit', async (t) => {
  const { dir, home } = setup(t, { command: 'node' });
  await run([dir, '--approve'], { home });
  const { baselinePath } = require('../lib/audit/baseline');
  fs.writeFileSync(baselinePath(home, dir), '{not json');
  const r = await run([dir, '--format', 'json', '--fail-on', 'none'], { home });
  assert.equal(r.code, 0);
  assert.ok(!JSON.parse(r.out).findings.some((f) => f.id === 'ZNA023'));
});

test('a removed hook is medium, a removed server is low, and a file that stopped being readable is high', async (t) => {
  const { dir, home } = setup(t, { command: 'node', args: ['server.js'] });
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node guard.js' }] }] } }));
  await run([dir, '--approve'], { home });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{}');
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{ not json');
  const r = await run([dir, '--format', 'json', '--fail-on', 'none'], { home });
  const f = JSON.parse(r.out).findings.filter((x) => x.id === 'ZNA023');
  const sev = (needle) => f.filter((x) => x.detail.includes(needle)).map((x) => x.severity);
  assert.deepEqual(sev('hook:PreToolUse'), ['medium']);
  assert.deepEqual(sev('mcp:tools'), ['low']);
  assert.deepEqual(sev('unreadable'), ['high']);
});
