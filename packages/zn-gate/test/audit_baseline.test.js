'use strict';

// The baseline of a project's executable configuration: what changes it reports and what it leaves alone. Values are fake.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractSurface, diffSurface, baselinePath, saveBaseline, loadBaseline } = require('../lib/audit/baseline');
const { tempDir } = require('./helpers/tmp');

function project(t, files) {
  const dir = tempDir(t, 'zn-baseline-');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

const MCP = { mcpServers: { tools: { command: 'node', args: ['server.js', '--port', '4000'], env: { MODE: 'dev' } }, docs: { type: 'http', url: 'https://docs.example.invalid/mcp' } } };

test('the surface holds one hash per executable entry and no value', (t) => {
  const dir = project(t, {
    '.mcp.json': MCP,
    '.claude/settings.json': { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node check.js' }] }] }, env: { ANTHROPIC_BASE_URL: 'https://gw.example.invalid', OTHER: 'x' }, permissions: { allow: ['Bash(npm test)'] } },
    'package.json': { scripts: { postinstall: 'node setup.js', test: 'node --test' } },
    '.vscode/tasks.json': '{ // comment\n "tasks": [{ "label": "auto", "command": "node x.js", "runOptions": { "runOn": "folderOpen" } }, { "label": "manual", "command": "node y.js" }] }',
  });
  const s = extractSurface(dir);
  assert.deepEqual(Object.keys(s).sort(), ['.claude/settings.json#env:ANTHROPIC_BASE_URL', '.claude/settings.json#hook:PreToolUse.0.0', '.claude/settings.json#permissions.allow',
    '.mcp.json#mcp:docs', '.mcp.json#mcp:tools', '.vscode/tasks.json#task:auto', 'package.json#script:postinstall']);
  for (const v of Object.values(s)) assert.match(v, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(s).includes('node setup.js') && !JSON.stringify(s).includes('example.invalid'), 'no value in the surface');
});

test('a reformat or a reorder of keys is not a change; a command, an argument, an address or a hook is', (t) => {
  const dir = project(t, { '.mcp.json': MCP });
  const base = extractSurface(dir);
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{\n  // same servers, other order and spacing\n  "mcpServers": {"docs":{"url":"https://docs.example.invalid/mcp","type":"http"},"tools":{"env":{"MODE":"dev"},"args":["server.js","--port","4000"],"command":"node"}}}');
  assert.deepEqual(diffSurface(base, extractSurface(dir)), { added: [], changed: [], removed: [] });
  for (const edit of [(m) => { m.mcpServers.tools.command = 'sh'; }, (m) => { m.mcpServers.tools.args[2] = '4001'; }, (m) => { m.mcpServers.docs.url = 'https://other.example.invalid/mcp'; },
    (m) => { m.mcpServers.tools.env.MODE = 'prod'; }]) {
    const m = JSON.parse(JSON.stringify(MCP));
    edit(m);
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify(m));
    const d = diffSurface(base, extractSurface(dir));
    assert.equal(d.changed.length + d.added.length + d.removed.length, 1, JSON.stringify(d));
  }
});

test('an entry added, removed or changed is reported by name', (t) => {
  const dir = project(t, { '.mcp.json': MCP, 'package.json': { scripts: { postinstall: 'node a.js' } } });
  const base = extractSurface(dir);
  const m = JSON.parse(JSON.stringify(MCP));
  delete m.mcpServers.docs;
  m.mcpServers.extra = { command: 'node', args: ['x.js'] };
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify(m));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { postinstall: 'node b.js', prepare: 'node c.js' } }));
  assert.deepEqual(diffSurface(base, extractSurface(dir)), {
    added: ['.mcp.json#mcp:extra', 'package.json#script:prepare'], changed: ['package.json#script:postinstall'], removed: ['.mcp.json#mcp:docs'],
  });
});

test('scripts that do not run on install, and settings keys that run nothing, are not part of the surface', (t) => {
  const dir = project(t, { 'package.json': { scripts: { test: 'node --test', build: 'node build.js' } }, '.claude/settings.json': { env: { FOO: '1' }, model: 'x' } });
  assert.deepEqual(extractSurface(dir), {});
});

test('a missing, huge, linked or broken file gives an empty surface and never throws', (t) => {
  const dir = project(t, { '.mcp.json': '{ not json', '.claude/settings.json': 'x'.repeat(1024 * 1024 + 1) });
  fs.symlinkSync(path.join(dir, '.mcp.json'), path.join(dir, '.cursor-link'));
  assert.deepEqual(extractSurface(dir), {});
  assert.deepEqual(extractSurface(path.join(dir, 'missing')), {});
});

test('the baseline is private to the user, keyed by the project path, and written whole', (t) => {
  const home = tempDir(t, 'zn-home-');
  const dir = project(t, { '.mcp.json': MCP });
  const surface = extractSurface(dir);
  const file = saveBaseline(home, dir, surface, new Date('2026-11-05T20:00:00Z'));
  assert.equal(file, baselinePath(home, dir));
  assert.equal(fs.statSync(file).mode & 0o777, process.platform === 'win32' ? fs.statSync(file).mode & 0o777 : 0o600);
  assert.deepEqual(loadBaseline(home, dir), surface);
  assert.equal(loadBaseline(home, path.join(dir, 'other')), null, 'another project has no baseline');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(dir), 'the path of the project is not written');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), []);
});

test('a damaged baseline is no baseline', (t) => {
  const home = tempDir(t, 'zn-home-');
  const dir = project(t, { '.mcp.json': MCP });
  const file = baselinePath(home, dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const bad of ['{ broken', '[]', '{"version":2,"entries":{}}', '{"version":1,"entries":[]}', '{"version":1,"entries":{"a":"not a hash"}}', '{"version":1,"entries":{"a":5}}']) {
    fs.writeFileSync(file, bad);
    assert.equal(loadBaseline(home, dir), null, bad);
  }
});

test('the order of the arguments of a command is part of it', (t) => {
  const dir = project(t, { '.mcp.json': { mcpServers: { a: { command: 'node', args: ['one', 'two'] } } } });
  const base = extractSurface(dir);
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'node', args: ['two', 'one'] } } }));
  assert.deepEqual(diffSurface(base, extractSurface(dir)).changed, ['.mcp.json#mcp:a']);
});

test('only a task that runs when the folder opens is part of the surface', (t) => {
  const dir = project(t, { '.vscode/tasks.json': { tasks: [{ label: 'default', command: 'x', runOptions: { reevaluateOnRerun: true } }, { label: 'later', command: 'y', runOptions: { runOn: 'default' } }, { label: 'auto', command: 'z', runOptions: { runOn: 'folderOpen' } }] } });
  assert.deepEqual(Object.keys(extractSurface(dir)), ['.vscode/tasks.json#task:auto']);
});

test('a file over the size cap is not read, even when it is valid JSON', (t) => {
  const big = '{"mcpServers":{"a":{"command":"node"}},"pad":"' + 'x'.repeat(1024 * 1024) + '"}';
  const dir = project(t, { '.mcp.json': big });
  assert.deepEqual(extractSurface(dir), {});
});
