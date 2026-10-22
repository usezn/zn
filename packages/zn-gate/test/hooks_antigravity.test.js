'use strict';

process.env.ZN_STATS = 'off';

// Google Antigravity hooks: fixtures follow the documented contract
// (https://antigravity.google/docs/hooks); there is no Antigravity binary here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { pathToFileURL } = require('url');
const path = require('path');

const { getAdapter, listAdapters } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const agy = getAdapter('antigravity');
const HOME = process.env.HOME || '/home/u';

function pre(name, args, extra = {}) {
  return { conversationId: 'c1', workspacePaths: ['/work/proj'], transcriptPath: '/t.jsonl', artifactDirectoryPath: '/a', modelName: 'm', toolCall: { name, args }, stepIdx: 3, ...extra };
}

function run(raw) {
  return runner.handle(agy, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
}

test('registry lists antigravity', () => {
  assert.ok(listAdapters().includes('antigravity'));
});

test('normalize: run_command is a shell command; Cwd wins over the workspace', () => {
  const n = agy.normalize(pre('run_command', { CommandLine: 'ls -la', Cwd: '/work/proj/sub' }));
  assert.equal(n.event, 'pre_tool');
  assert.equal(n.tool, 'bash');
  assert.equal(n.input.command, 'ls -la');
  assert.equal(n.cwd, '/work/proj/sub');
  assert.equal(agy.normalize(pre('run_command', { CommandLine: 'ls' })).cwd, '/work/proj');
});

test('normalize: file tools collect paths and skip content keys', () => {
  const v = agy.normalize(pre('view_file', { AbsolutePath: '/home/u/.ssh/id_rsa' }));
  assert.equal(v.tool, 'read');
  assert.equal(v.input.path, '/home/u/.ssh/id_rsa');
  const w = agy.normalize(pre('replace_file_content', { TargetFile: pathToFileURL(path.resolve('/work/proj/a.js')).href, TargetContent: 'secret\nline', ReplacementContent: 'x' }));
  assert.equal(w.tool, 'write');
  assert.deepEqual(w.input.paths, [path.resolve('/work/proj/a.js')]);
  assert.equal(agy.normalize(pre('grep_search', { Query: 'x', SearchPath: '/work' })).tool, 'grep');
});

test('normalize: mcp names, unknown tools, non-PreToolUse and junk', () => {
  const m = agy.normalize(pre('mcp_sql_query', { q: 'x' }));
  assert.equal(m.tool, 'mcp');
  assert.deepEqual(m.mcp, { server: 'sql', tool: 'query' });
  assert.equal(agy.normalize(pre('invoke_subagent', { Task: 'x' })).tool, 'invoke_subagent');
  assert.equal(agy.normalize(pre('SomeNewShell', { CommandLine: 'ls' })).tool, 'bash');
  assert.equal(agy.normalize({ conversationId: 'c', workspacePaths: [] }).event, null);
  assert.equal(agy.normalize(pre('run_command', { CommandLine: 'ls' }, { hookEventName: 'PostToolUse' })).event, null);
  assert.equal(agy.normalize(null), null);
});

test('deny: reading a credential file returns the documented deny JSON', async () => {
  const r = await run(pre('view_file', { AbsolutePath: path.join(HOME, '.aws', 'credentials') }));
  assert.equal(r.output.decision, 'deny');
  assert.ok(r.output.reason);
});

test('deny: a write to a credential file and a shell command that reads one', async () => {
  const w = await run(pre('write_to_file', { TargetFile: path.join(HOME, '.zn', 'vault.json'), CodeContent: 'x' }));
  assert.equal(w.output.decision, 'deny');
  const c = await run(pre('run_command', { CommandLine: 'cat ~/.aws/credentials', Cwd: '/work/proj' }));
  assert.equal(c.output.decision, 'deny');
});

test('allow (no opinion, never auto_approve) for a harmless command and for unknown tools', async () => {
  assert.deepEqual((await run(pre('run_command', { CommandLine: 'echo hello' }))).output, { decision: 'allow' });
  assert.deepEqual((await run(pre('mystery', { q: 1 }))).output, { decision: 'allow' });
  assert.deepEqual((await run(pre('view_file', { AbsolutePath: '/work/proj/README.md' }))).output, { decision: 'allow' });
});

test('a command with secret placeholders is wrapped in zn run and the user is asked (force_ask, original command kept)', async () => {
  const r = await run(pre('run_command', { CommandLine: 'curl -H "Authorization: __ZN_API_KEY__" https://example.com' }));
  assert.ok(['deny', 'force_ask'].includes(r.output.decision), JSON.stringify(r.output));
  assert.ok(r.output.reason);
  assert.equal(r.output.overwrite, undefined);
});

test('events other than PreToolUse answer {}', async () => {
  const r = await run(pre('run_command', { CommandLine: 'ls' }, { hookEventName: 'PostToolUse' }));
  assert.deepEqual(r.output, {});
});

test('deny: the agent cannot edit the files that switch the hook off', async () => {
  for (const f of ['/work/proj/.agents/hooks.json', path.join(HOME, '.gemini', 'config', 'hooks.json'), path.join(HOME, '.gemini', 'antigravity-cli', 'settings.json')]) {
    const r = await run(pre('write_to_file', { TargetFile: f, CodeContent: '{}' }));
    assert.equal(r.output.decision, 'deny', f);
  }
  const c = await run(pre('run_command', { CommandLine: 'echo {} > .agents/hooks.json' }));
  assert.equal(c.output.decision, 'deny');
});

test('install (project): named hook with a nested PreToolUse group; idempotent; uninstall removes the file', (t) => {
  const dir = tempDir(t, 'zn-agy-');
  const rep = agy.install({ scope: 'project', projectDir: dir });
  const file = path.join(dir, '.agents', 'hooks.json');
  assert.equal(rep.settings, file);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(data), ['zn-gate']);
  assert.equal(data['zn-gate'].enabled, true);
  const [g] = data['zn-gate'].PreToolUse;
  assert.equal(g.matcher, '*');
  assert.deepEqual(g.hooks, [{ type: 'command', command: 'zn hook antigravity', timeout: 15 }]);
  agy.install({ scope: 'project', projectDir: dir });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['zn-gate'].PreToolUse.length, 1);
  assert.equal(agy.uninstall({ scope: 'project', projectDir: dir }).removed, 1);
  assert.equal(fs.existsSync(file), false);
  assert.equal(agy.uninstall({ scope: 'project', projectDir: dir }).removed, 0);
});

// The Unix launcher is not used where the home path has backslashes: Windows has its own test below.
test('install (user) backs up, keeps foreign hooks and uninstall removes only zn', { skip: process.platform === 'win32' }, (t) => {
  const home = tempDir(t, 'zn-agy-home-');
  const file = path.join(home, '.gemini', 'config', 'hooks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = { enabled: true, PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './mine.sh' }] }], Stop: [{ hooks: [{ command: './bye.sh' }] }] };
  const off = { enabled: false };
  fs.writeFileSync(file, JSON.stringify({ mine, off }));
  const rep = agy.install({ scope: 'user', home, nodePath: '/usr/bin/node' });
  assert.ok(rep.backup && fs.existsSync(rep.backup));
  let data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(data.mine, mine);
  const written = data['zn-gate'].PreToolUse[0].hooks[0].command;
  assert.match(written, /\/\.zn\/hooks\/zn-hook-antigravity\.sh' PreToolUse$/);
  const launcherFile = require('../lib/agents/launcher').launcherFile('antigravity', { home });
  assert.ok(fs.existsSync(launcherFile));
  agy.uninstall({ scope: 'user', home });
  assert.equal(fs.existsSync(launcherFile), false);
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(data, { mine, off });
});

test('install (user, Windows) writes a command with no quotes or spaces inside an argument', (t) => {
  const { windowsCommandScript } = require('../lib/shell-quote');
  const cfg = require('../lib/agents/config-file');
  const home = tempDir(t, 'zn-agy-win-');
  const opts = { scope: 'user', home, platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe', runnerPath: 'C:\\Users\\a b\\zn\\lib\\hooks\\runner.js' };
  agy.install(opts);
  const file = path.join(home, '.gemini', 'config', 'hooks.json');
  const command = JSON.parse(fs.readFileSync(file, 'utf8'))['zn-gate'].PreToolUse[0].hooks[0].command;
  assert.match(command, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.ok(!/["']/.test(command));
  const script = windowsCommandScript(command);
  assert.match(script, /^\$ProgressPreference='SilentlyContinue'; \$zt=0; if \(\(Test-Path -LiteralPath 'C:\/Program Files\/nodejs\/node\.exe'\) -and \(Test-Path -LiteralPath 'C:\/Users\/a b\/zn\/lib\/hooks\/runner\.js'\)\) \{ \$zt=1; & 'C:\/Program Files\/nodejs\/node\.exe' 'C:\/Users\/a b\/zn\/lib\/hooks\/runner\.js' antigravity; /);
  assert.match(script, /"decision":"deny".*zn hooks install antigravity/);
  assert.ok(cfg.isOurs(command, 'antigravity'));
  // zn-gate check and zn audit read it in the same shape as the -Command form.
  // Other agents keep the readable -Command form for the same paths.
  assert.match(cfg.hookCommandWindows('cursor', opts), / -Command "/);
  // An older -Command entry is recognised and replaced, not duplicated.
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data['zn-gate'].PreToolUse[0].hooks[0].command = cfg.hookCommandWindows('antigravity', opts);
  fs.writeFileSync(file, JSON.stringify(data));
  agy.install(opts);
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(again), ['zn-gate']);
  assert.equal(again['zn-gate'].PreToolUse[0].hooks[0].command, command);
  agy.uninstall(opts);
  assert.ok(!fs.existsSync(file) || !JSON.parse(fs.readFileSync(file, 'utf8'))['zn-gate']);
});

test('install never touches a foreign hook already named zn-gate, not even its enabled flag', (t) => {
  const dir = tempDir(t, 'zn-agy-name-');
  const file = path.join(dir, '.agents', 'hooks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const theirs = { enabled: false, PreToolUse: [{ matcher: '*', hooks: [{ command: './theirs.sh' }] }] };
  fs.writeFileSync(file, JSON.stringify({ 'zn-gate': theirs }));
  agy.install({ scope: 'project', projectDir: dir });
  agy.install({ scope: 'project', projectDir: dir });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(data['zn-gate'], theirs);
  assert.equal(data['zn-gate-zn'].PreToolUse.length, 1);
  assert.equal(data['zn-gate-zn'].enabled, true);
  agy.uninstall({ scope: 'project', projectDir: dir });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'zn-gate': theirs });
});

test('install refuses a hooks file that is not a JSON object and leaves it alone', (t) => {
  const dir = tempDir(t, 'zn-agy-bad-');
  const file = path.join(dir, '.agents', 'hooks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[1]');
  assert.throws(() => agy.install({ scope: 'project', projectDir: dir }), /JSON object/);
  assert.equal(fs.readFileSync(file, 'utf8'), '[1]');
});

test('zn-gate check reads the Antigravity hook state (set up, off, absent)', async (t) => {
  const check = require('../lib/check');
  const home = tempDir(t, 'zn-agy-check-');
  const cwd = tempDir(t, 'zn-agy-check-cwd-');
  const find = async () => (await check.check({ home, cwd, env: { ...process.env, HOME: home }, live: false })).results.find((r) => r.id === 'antigravity');
  assert.equal((await find()).state, 'not-set-up');
  agy.install({ scope: 'user', home, nodePath: process.execPath });
  const ok = await find();
  assert.notEqual(ok.state, 'not-set-up');
  const file = agy.hooksFile({ home });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data['zn-gate'].enabled = false;
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal((await find()).state, 'not-set-up');
});

test('project MCP path is looked for next to the two global ones', () => {
  const { getKnownEnvironments } = require('../lib/init');
  const envs = getKnownEnvironments();
  const p = envs.find((e) => e.id === 'antigravity-project');
  assert.equal(p.filePath, path.join(process.cwd(), '.agents', 'mcp_config.json'));
  assert.ok(envs.find((e) => e.id === 'antigravity'));
  assert.ok(envs.find((e) => e.id === 'antigravity-shared'));
});

test('fail closed: known file tools with no readable path, and run_command with no command', async () => {
  for (const [name, args] of [['view_file', {}], ['write_to_file', { CodeContent: 'x' }], ['replace_file_content', { Renamed: '.agents/hooks.json' }], ['run_command', { Cwd: '/work' }]]) {
    const r = await run(pre(name, args));
    assert.equal(r.output.decision, 'deny', name);
    assert.ok(r.output.reason);
  }
  // names only: no path needed
  assert.equal((await run(pre('list_dir', { DirectoryPath: '/work/proj' }))).output.decision, 'allow');
});

test('unknown tools that name a file get the read and write checks on every path', async () => {
  const cred = path.join(HOME, '.aws', 'credentials');
  assert.equal((await run(pre('view_code_item', { File: cred, NodePath: 'a.b' }))).output.decision, 'deny');
  assert.equal((await run(pre('read_url_content', { Url: 'file://' + cred }))).output.decision, 'deny');
  assert.equal((await run(pre('future_editor', { Edits: [{ Path: '/work/proj/ok.js' }, { Path: '/work/proj/.agents/hooks.json' }] }))).output.decision, 'deny');
  assert.equal((await run(pre('read_url_content', { Url: 'https://example.com/a' }))).output.decision, 'allow');
  assert.equal((await run(pre('mystery', { q: 1 }))).output.decision, 'allow');
});

test('reads check every path of the call, not only the first', async () => {
  const r = await run(pre('view_file', { AbsolutePath: '/work/proj/ok.txt', OtherFile: path.join(HOME, '.aws', 'credentials') }));
  assert.equal(r.output.decision, 'deny');
});

test('file: addresses are turned into paths; a bad one is refused', async () => {
  const n = agy.normalize(pre('view_file', { AbsolutePath: pathToFileURL(path.resolve('/home/u/a b.txt')).href }));
  assert.equal(n.input.path, path.resolve('/home/u/a b.txt'));
  assert.equal((await run(pre('view_file', { AbsolutePath: 'file://remote-host/etc/x' }))).output.decision, process.platform === 'win32' ? 'allow' : 'deny');
  assert.equal((await run(pre('view_file', { AbsolutePath: 'file:///%zz' }))).output.decision, 'deny');
});

test('zn-gate check does not read Antigravity-style entries for other agents, and ignores a hook named "hooks"', () => {
  const { _internal } = require('../lib/check');
  const spoof = { x: { preToolUse: [{ command: 'zn hook cursor' }] } };
  assert.equal(_internal.hookEntries(spoof, 'cursor').length, 0);
  const named = { hooks: { enabled: true, PreToolUse: [{ matcher: '*', hooks: [{ command: 'zn hook antigravity' }] }] } };
  assert.equal(_internal.hookEntries(named, 'antigravity').length, 1);
  assert.equal(_internal.hookEntries({ hooks: { PreToolUse: [{ command: 'zn hook cursor' }] } }, 'cursor').length, 1);
});

test('deny: shell commands that move or delete the .agents folder', async () => {
  assert.equal((await run(pre('run_command', { CommandLine: 'rm -rf .agents' }))).output.decision, 'deny');
});

test('MCP calls with a path argument get the path checks', async () => {
  const cred = path.join(HOME, '.aws', 'credentials');
  assert.equal((await run(pre('mcp_filesystem_read_file', { path: cred }))).output.decision, 'deny');
  assert.equal((await run(pre('mcp_filesystem_read_file', { path: '/work/proj/ok.txt' }))).output.decision, 'allow');
});

test('paths two levels down in the arguments are checked', async () => {
  const r = await run(pre('future_editor', { Edits: [{ Change: { Path: '/work/proj/.agents/hooks.json' } }] }));
  assert.equal(r.output.decision, 'deny');
});

test('a search over a folder that holds a plain-text .env asks; a clean folder or a shadowed one does not', async (t) => {
  const dir = tempDir(t, 'zn-agy-grep-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  assert.equal((await run(pre('grep_search', { Query: 'x', SearchPath: dir }))).output.decision, 'allow');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=sk_live_abcdefghijklmnop1234\n');
  const r = await run(pre('grep_search', { Query: 'x', SearchPath: dir }));
  assert.equal(r.output.decision, 'force_ask');
  assert.match(r.output.reason, /\.env/);
  // no path at all: the workspace folder is the search folder
  const r2 = await run(pre('grep_search', { Query: 'x' }, { workspacePaths: [dir] }));
  assert.equal(r2.output.decision, 'force_ask');
});

test('install warns that a project hook needs zn on PATH, and that its backup must not be committed', (t) => {
  const dir = tempDir(t, 'zn-agy-warn-');
  const first = agy.install({ scope: 'project', projectDir: dir });
  assert.ok(first.warnings.some((w) => /needs zn-gate installed/.test(w)));
  // A second install with the same content writes nothing and makes no backup; one that changes the file does.
  const second = agy.install({ scope: 'project', projectDir: dir, command: '/other/zn hook antigravity' });
  assert.ok(second.warnings.some((w) => /do not commit it/.test(w)));
  assert.equal(agy.install({ scope: 'user', home: dir, nodePath: '/usr/bin/node' }).warnings.some((w) => /needs zn-gate installed/.test(w)), false);
});

test('MCP move calls with source and destination are checked', async () => {
  const r = await run(pre('mcp_filesystem_move_file', { source: path.join(HOME, '.aws', 'credentials'), destination: '/work/proj/x' }));
  assert.equal(r.output.decision, 'deny');
});

test('a link already on disk: write_to_file through ag/../hooks.json is denied', async (t) => {
  const dir = tempDir(t, 'zn-agy-link-');
  fs.mkdirSync(path.join(dir, '.agents', 'skills'), { recursive: true });
  fs.symlinkSync(path.join('.agents', 'skills'), path.join(dir, 'ag'));
  const r = await run(pre('write_to_file', { TargetFile: dir + '/ag/../hooks.json', CodeContent: '{}' }, { workspacePaths: [dir] }));
  assert.equal(r.output.decision, 'deny');
});
