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
  assert.deepEqual(Object.keys(s).sort(), ['.claude/settings.json#env:ANTHROPIC_BASE_URL', '.claude/settings.json#hook:PreToolUse.0.0', '.claude/settings.json#permissions',
    '.mcp.json#mcp:docs', '.mcp.json#mcp:tools', '.vscode/tasks.json#task:label:auto', 'package.json#script:postinstall']);
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

test('a missing folder gives an empty surface; a huge or broken file is an entry of its own; nothing throws', (t) => {
  const dir = project(t, { '.mcp.json': '{ not json', '.claude/settings.json': 'x'.repeat(1024 * 1024 + 1) });
  assert.deepEqual(Object.keys(extractSurface(dir)).sort(), ['.claude/settings.json#unreadable', '.mcp.json#unreadable']);
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
  for (const bad of ['{ broken', '[]', '{"version":3,"entries":{}}', '{"version":1,"entries":{}}', '{"version":1,"entries":[]}', '{"version":1,"entries":{"a":"not a hash"}}', '{"version":1,"entries":{"a":5}}']) {
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
  assert.deepEqual(Object.keys(extractSurface(dir)), ['.vscode/tasks.json#task:label:auto']);
});

test('a file over the size cap is not read, even when it is valid JSON: it is an entry of its own', (t) => {
  const big = '{"mcpServers":{"a":{"command":"node"}},"pad":"' + 'x'.repeat(1024 * 1024) + '"}';
  const dir = project(t, { '.mcp.json': big });
  assert.deepEqual(Object.keys(extractSurface(dir)), ['.mcp.json#unreadable']);
});

// --- review of #853: what is approved, and what a change can hide behind ---

const SETTINGS_WITH_HOOK = { hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node guard.js' }] }] }, permissions: { allow: ['Bash(ls)'], deny: ['Read(.env)'], defaultMode: 'default' } };

function changedBy(t, files, edit) {
  const dir = project(t, files);
  const base = extractSurface(dir);
  edit(dir);
  return diffSurface(base, extractSurface(dir));
}
const write = (dir, rel, v) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), typeof v === 'string' ? v : JSON.stringify(v)); };

test('the matcher of a hook is part of what is approved', (t) => {
  const d = changedBy(t, { '.claude/settings.json': SETTINGS_WITH_HOOK }, (dir) => {
    const s = JSON.parse(JSON.stringify(SETTINGS_WITH_HOOK));
    s.hooks.PreToolUse[0].matcher = 'NoSuchTool';
    write(dir, '.claude/settings.json', s);
  });
  assert.deepEqual(d.changed, ['.claude/settings.json#hook:PreToolUse.0.0']);
});

test('disableAllHooks, a removed deny rule, the default mode and a helper command are changes', (t) => {
  const edits = [
    (s) => { s.disableAllHooks = true; },
    (s) => { s.permissions.deny = []; },
    (s) => { s.permissions.defaultMode = 'bypassPermissions'; },
    (s) => { s.otelHeadersHelper = 'node helper.js'; },
    (s) => { s.env = { LD_PRELOAD: '/tmp/x.so' }; },
    (s) => { s.env = { BASH_ENV: '/tmp/x.sh' }; },
  ];
  for (const edit of edits) {
    const d = changedBy(t, { '.claude/settings.json': SETTINGS_WITH_HOOK }, (dir) => {
      const s = JSON.parse(JSON.stringify(SETTINGS_WITH_HOOK));
      edit(s);
      write(dir, '.claude/settings.json', s);
    });
    assert.equal(d.changed.length + d.added.length + d.removed.length, 1, edit.toString() + ' ' + JSON.stringify(d));
  }
});

test('the MCP servers of Codex (TOML), OpenCode and Amazon Q are covered, and a dev container command', (t) => {
  const dir = project(t, {
    '.codex/config.toml': '[mcp_servers.docs]\ncommand = "node"\nargs = ["a.js"]\n',
    'opencode.json': { mcp: { tools: { type: 'local', command: ['node', 'a.js'] } } },
    '.amazonq/mcp.json': { mcpServers: { q: { command: 'node', args: ['q.js'] } } },
    '.devcontainer/devcontainer.json': '{ // c\n "postCreateCommand": "npm ci" }',
  });
  const base = extractSurface(dir);
  assert.deepEqual(Object.keys(base).sort(), ['.amazonq/mcp.json#mcp:q', '.codex/config.toml#mcp:docs', '.devcontainer/devcontainer.json#devcontainer:postCreateCommand', 'opencode.json#mcp:tools']);
  write(dir, '.codex/config.toml', '[mcp_servers.docs]\ncommand = "sh"\nargs = ["a.js"]\n');
  write(dir, 'opencode.json', { mcp: { tools: { type: 'local', command: ['node', 'b.js'] } } });
  write(dir, '.amazonq/mcp.json', { mcpServers: { q: { command: 'node', args: ['other.js'] } } });
  write(dir, '.devcontainer/devcontainer.json', '{ "postCreateCommand": "curl x | sh" }');
  assert.deepEqual(diffSurface(base, extractSurface(dir)).changed, ['.amazonq/mcp.json#mcp:q', '.codex/config.toml#mcp:docs', '.devcontainer/devcontainer.json#devcontainer:postCreateCommand', 'opencode.json#mcp:tools']);
});

test('a config file that is a link inside the project is followed; one that leaves the project, is broken, too large or invalid is an entry of its own', (t) => {
  if (process.platform === 'win32') return t.skip('links need privileges on Windows');
  const dir = project(t, { 'conf/mcp.json': { mcpServers: { a: { command: 'node', args: ['a.js'] } } } });
  fs.symlinkSync('conf/mcp.json', path.join(dir, '.mcp.json'));
  const base = extractSurface(dir);
  assert.deepEqual(Object.keys(base), ['.mcp.json#mcp:a']);
  write(dir, 'conf/mcp.json', { mcpServers: { a: { command: 'sh', args: ['a.js'] } } });
  assert.deepEqual(diffSurface(base, extractSurface(dir)).changed, ['.mcp.json#mcp:a']);
  // replaced by a link that leaves the project
  const outside = project(t, { 'x.json': { mcpServers: { evil: { command: 'sh' } } } });
  fs.rmSync(path.join(dir, '.mcp.json'));
  fs.symlinkSync(path.join(outside, 'x.json'), path.join(dir, '.mcp.json'));
  const d = diffSurface(base, extractSurface(dir));
  assert.deepEqual(d.added, ['.mcp.json#unreadable']);
  assert.deepEqual(d.removed, ['.mcp.json#mcp:a']);
  // broken link, invalid file, file over the size limit
  fs.rmSync(path.join(dir, '.mcp.json'));
  fs.symlinkSync(path.join(dir, 'nowhere.json'), path.join(dir, '.mcp.json'));
  assert.deepEqual(diffSurface(base, extractSurface(dir)).added, ['.mcp.json#unreadable']);
  fs.rmSync(path.join(dir, '.mcp.json'));
  write(dir, '.mcp.json', '{ not json');
  const bad1 = extractSurface(dir)['.mcp.json#unreadable'];
  assert.match(bad1, /^[0-9a-f]{64}$/);
  write(dir, '.mcp.json', '{ not json either');
  assert.notEqual(extractSurface(dir)['.mcp.json#unreadable'], bad1, 'a change of an unreadable file is a change');
  write(dir, '.mcp.json', JSON.stringify({ mcpServers: { a: { command: 'node', args: ['x'.repeat(1100 * 1024)] } } }));
  assert.deepEqual(Object.keys(extractSurface(dir)), ['.mcp.json#unreadable']);
});

test('the baseline of a project is found through a link to its folder', (t) => {
  if (process.platform === 'win32') return t.skip('links need privileges on Windows');
  const dir = project(t, { '.mcp.json': MCP });
  const home = tempDir(t, 'zn-baseline-home-');
  const link = path.join(tempDir(t, 'zn-baseline-link-'), 'alias');
  fs.symlinkSync(dir, link);
  saveBaseline(home, dir, extractSurface(dir));
  assert.ok(loadBaseline(home, link), 'found through the link');
  assert.equal(baselinePath(home, link), baselinePath(home, dir));
});

test('an outside link approved as it is: a change of its target is a change', (t) => {
  if (process.platform === 'win32') return t.skip('links need privileges on Windows');
  const outside = project(t, { 'x.json': { mcpServers: { a: { command: 'node' } } } });
  const dir = project(t, {});
  fs.symlinkSync(path.join(outside, 'x.json'), path.join(dir, '.mcp.json'));
  const base = extractSurface(dir);
  assert.deepEqual(Object.keys(base), ['.mcp.json#unreadable']);
  assert.ok(!JSON.stringify(base).includes(outside), 'the path of the target is not kept');
  write(outside, 'x.json', { mcpServers: { a: { command: 'sh' } } });
  assert.deepEqual(diffSurface(base, extractSurface(dir)).changed, ['.mcp.json#unreadable']);
});

test('loader and shell-prefix environment overrides are covered', (t) => {
  for (const name of ['DYLD_INSERT_LIBRARIES', 'CLAUDE_CODE_SHELL_PREFIX', 'PERL5OPT']) {
    const d = changedBy(t, { '.claude/settings.json': SETTINGS_WITH_HOOK }, (dir) => {
      const s = JSON.parse(JSON.stringify(SETTINGS_WITH_HOOK));
      s.env = { [name]: '/tmp/x' };
      write(dir, '.claude/settings.json', s);
    });
    assert.deepEqual(d.added, ['.claude/settings.json#env:' + name]);
  }
});

// --- review of #1089: a folder-open task is keyed by its label (all tasks that share it) or, unlabeled, by its index ---

const TASK = (label, command) => ({ label, command, runOptions: { runOn: 'folderOpen' } });

test('a folder-open task inserted under the label of an approved one is a change', (t) => {
  const dir = project(t, { '.vscode/tasks.json': { tasks: [TASK('auto', 'node ok.js')] } });
  const base = extractSurface(dir);
  fs.writeFileSync(path.join(dir, '.vscode/tasks.json'), JSON.stringify({ tasks: [TASK('auto', 'node evil.js'), TASK('auto', 'node ok.js')] }));
  assert.deepEqual(diffSurface(base, extractSurface(dir)), { added: [], changed: ['.vscode/tasks.json#task:label:auto'], removed: [] });
});

test('an unlabeled task is keyed by its index and cannot collide with a task labeled with that number', (t) => {
  const files = { tasks: [TASK('a', 'x'), { command: 'y', runOptions: { runOn: 'folderOpen' } }, TASK('1', 'z')] };
  const dir = project(t, { '.vscode/tasks.json': files });
  const base = extractSurface(dir);
  assert.deepEqual(Object.keys(base).sort(), ['.vscode/tasks.json#task:index:1', '.vscode/tasks.json#task:label:1', '.vscode/tasks.json#task:label:a']);
  files.tasks[1].command = 'changed';
  fs.writeFileSync(path.join(dir, '.vscode/tasks.json'), JSON.stringify(files));
  assert.deepEqual(diffSurface(base, extractSurface(dir)).changed, ['.vscode/tasks.json#task:index:1']);
  files.tasks[1].command = 'y';
  files.tasks[2].command = 'changed';
  fs.writeFileSync(path.join(dir, '.vscode/tasks.json'), JSON.stringify(files));
  assert.deepEqual(diffSurface(base, extractSurface(dir)).changed, ['.vscode/tasks.json#task:label:1']);
});

test('two folder-open tasks with different labels that swap places are not a change', (t) => {
  const dir = project(t, { '.vscode/tasks.json': { tasks: [TASK('a', 'x'), TASK('b', 'y')] } });
  const base = extractSurface(dir);
  fs.writeFileSync(path.join(dir, '.vscode/tasks.json'), JSON.stringify({ tasks: [TASK('b', 'y'), TASK('a', 'x')] }));
  assert.deepEqual(diffSurface(base, extractSurface(dir)), { added: [], changed: [], removed: [] });
});

test('a baseline in the earlier format reads as no baseline until the project is approved again', (t) => {
  const home = tempDir(t, 'zn-home-');
  const dir = project(t, { '.mcp.json': MCP });
  const file = saveBaseline(home, dir, extractSurface(dir));
  assert.ok(loadBaseline(home, dir));
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  old.version = 1;
  fs.writeFileSync(file, JSON.stringify(old));
  assert.equal(loadBaseline(home, dir), null);
});
