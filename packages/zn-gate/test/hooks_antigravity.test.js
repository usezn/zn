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
const { budget } = require('./helpers/time_budget');

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
  // A payload without a tool call is a malformed PreToolUse (zn installs only that event): it is refused, not ignored.
  const empty = agy.normalize({ conversationId: 'c', workspacePaths: [] });
  assert.equal(empty.event, 'pre_tool');
  assert.match(empty.unreadable, /could not read the tool call/);
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

test('a named event other than PreToolUse answers {} (its documented answer)', async () => {
  const r = await run(pre('run_command', { CommandLine: 'ls' }, { hookEventName: 'PostToolUse' }));
  assert.deepEqual(r.output, {});
});

const VALID = new Set(['allow', 'auto_approve', 'deny', 'ask', 'force_ask', 'deny_unless_prior_grant']);

test('every answer for a tool call is an explicit decision, never {} (Antigravity denies the call on {})', async () => {
  const calls = [
    pre('run_command', { CommandLine: 'ls' }),
    pre('run_command', { Cwd: '/work' }),
    pre('zn_unknown_tool', {}),
    pre('view_file', {}),
    { conversationId: 'c1' }, // not a tool call, no event name
  ];
  for (const raw of calls) {
    const r = await run(raw);
    assert.ok(r.output && VALID.has(r.output.decision), JSON.stringify(raw) + ' -> ' + JSON.stringify(r.output));
    if (r.output.decision === 'deny') assert.ok(r.output.reason, 'a deny carries a reason');
  }
});

test('an internal error answers deny with a plain reason (fail-closed), not nothing', async () => {
  const broken = { id: 'antigravity', normalize: () => { throw new Error('boom'); }, respond: agy.respond };
  const r = await runner.handle(broken, pre('run_command', { CommandLine: 'ls' }), { engine: fakeEngine, vault: createFakeVault(), failMode: 'closed' });
  assert.equal(r.output.decision, 'deny');
  assert.ok(typeof r.output.reason === 'string' && r.output.reason.length > 10);
  // with hooks.whenUnavailable "allow" and a failure other than a missing engine, it is still a deny
  const r2 = agy.respond({ decision: 'allow', event: null });
  assert.equal(r2.decision, 'deny');
  assert.ok(r2.reason);
});

test('main: input that cannot be read prints a deny decision as JSON on stdout', async () => {
  const chunks = [];
  const orig = process.stdout.write;
  const code = process.exitCode;
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await runner.main(['antigravity'], async () => 'this is not json');
    await runner.main(['antigravity'], async () => '');
  } finally { process.stdout.write = orig; process.exitCode = code; }
  assert.equal(chunks.length, 2);
  for (const c of chunks) {
    const o = JSON.parse(c);
    assert.equal(o.decision, 'deny');
    assert.ok(o.reason);
  }
});

test('selfCheck: passes for a hook that answers allow; fails for nothing, {}, text, deny and a missing command', () => {
  const node = JSON.stringify(process.execPath);
  const say = (js) => node + ' -e ' + JSON.stringify(js);
  assert.equal(agy.selfCheck(say("process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({decision:'allow'})))")).ok, true);
  assert.equal(agy.selfCheck(say('0')).ok, false);
  assert.equal(agy.selfCheck(say("console.log('{}')")).ok, false);
  assert.equal(agy.selfCheck(say("console.log('hello')")).ok, false);
  const denied = agy.selfCheck(say("console.log(JSON.stringify({decision:'deny',reason:'nope'}))"));
  assert.equal(denied.ok, false);
  assert.match(denied.detail, /deny/);
  assert.equal(agy.selfCheck('zn-no-such-command-xyz').ok, false);
});

test('install with selfCheck runs the real hook once: ok, and a broken command is reported with a next step', (t) => {
  const home = tempDir(t, 'zn-agy-sc-');
  const good = agy.install({ scope: 'user', home, selfCheck: true, env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(good.selfCheck.ok, true, JSON.stringify(good.selfCheck));
  assert.ok(good.warnings.some((w) => /Self-check passed/.test(w)));
  const dir = tempDir(t, 'zn-agy-sc2-');
  const bad = agy.install({ scope: 'project', projectDir: dir, command: 'zn-no-such-command-xyz', selfCheck: true });
  assert.equal(bad.selfCheck.ok, false);
  assert.ok(bad.warnings.some((w) => /SELF-CHECK FAILED/.test(w) && /Next step/.test(w)));
  const plain = agy.install({ scope: 'project', projectDir: dir });
  assert.equal(plain.selfCheck, undefined);
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
  // The shared project file names `zn` on the PATH inside zn's own guard (see hooks_antigravity_project.test.js).
  const launcher = require('../lib/agents/launcher');
  const guarded = process.platform === 'win32' ? launcher.windowsScriptCommand(launcher.projectWindowsScript('antigravity')) : launcher.projectShCommand('antigravity');
  assert.deepEqual(g.hooks, [{ type: 'command', command: guarded, timeout: 15 }]);
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
  assert.match(written, /\/\.zn\/hooks\/zn-hook-antigravity\.sh PreToolUse$/);
  const launcherFile = require('../lib/agents/launcher').launcherFile('antigravity', { home });
  assert.ok(fs.existsSync(launcherFile));
  agy.uninstall({ scope: 'user', home });
  assert.equal(fs.existsSync(launcherFile), true, 'one uninstall keeps the shared launcher');
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
  assert.match(command, /^C:\/Windows\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.ok(!/["']/.test(command));
  const script = windowsCommandScript(command);
  assert.match(script, /^\$ProgressPreference='SilentlyContinue'; \$zt=0; \$za = .*?function zf\(\$x\) \{.*?return \$null \}; if \(\[System\.IO\.File\]::Exists\('C:\/Program Files\/nodejs\/node\.exe'\) -and \[System\.IO\.File\]::Exists\('C:\/Users\/a b\/zn\/lib\/hooks\/runner\.js'\)\) \{ \$zt=1; & 'C:\/Program Files\/nodejs\/node\.exe' 'C:\/Users\/a b\/zn\/lib\/hooks\/runner\.js' antigravity; /);
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
  // zn's hook is there but turned off: Antigravity skips it, so it is reported as not protected (check_antigravity_hooks.test.js)
  assert.equal((await find()).state, 'not-protected');
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

test('write_to_file and multi_replace_file_content on a plain-text .env are denied; other files are not', async (t) => {
  const dir = tempDir(t, 'zn-agy-envwrite-');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=example-not-a-real-key\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  const ws = { workspacePaths: [dir] };
  const envFile = path.join(dir, '.env');
  assert.equal((await run(pre('write_to_file', { TargetFile: envFile, CodeContent: 'x' }, ws))).output.decision, 'deny');
  assert.equal((await run(pre('multi_replace_file_content', { TargetFile: envFile, ReplacementChunks: [{ TargetContent: 'a', ReplacementContent: 'b' }] }, ws))).output.decision, 'deny');
  assert.equal((await run(pre('replace_file_content', { TargetFile: envFile, TargetContent: 'a', ReplacementContent: 'b' }, ws))).output.decision, 'deny');
  const readme = path.join(dir, 'README.md');
  assert.equal((await run(pre('write_to_file', { TargetFile: readme, CodeContent: 'x' }, ws))).output.decision, 'allow');
  assert.equal((await run(pre('multi_replace_file_content', { TargetFile: readme, ReplacementChunks: [] }, ws))).output.decision, 'allow');
  // a known file tool with no readable path is refused
  assert.equal((await run(pre('multi_replace_file_content', { ReplacementChunks: [] }, ws))).output.decision, 'deny');
});

test('a recursive shell search over a folder with a plain-text .env asks, like the search tool does', async (t) => {
  const dir = tempDir(t, 'zn-agy-shellgrep-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const ws = { workspacePaths: [dir] };
  const shell = async (line, args = {}) => (await run(pre('run_command', { CommandLine: line, Cwd: dir, ...args }, ws))).output;
  assert.equal((await shell('grep -r API_KEY .')).decision, 'allow'); // clean folder
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=example-not-a-real-key\n');
  const viaTool = (await run(pre('grep_search', { Query: 'API_KEY', SearchPath: dir }, ws))).output;
  assert.equal(viaTool.decision, 'force_ask');
  for (const line of ['grep -r API_KEY .', 'grep -rn API_KEY', 'grep --recursive API_KEY ' + dir, 'rg API_KEY', 'egrep -R "API_KEY" .']) {
    const r = await shell(line);
    assert.equal(r.decision, viaTool.decision, line);
    assert.equal(r.reason, viaTool.reason, line);
  }
  assert.equal((await shell('grep API_KEY a.txt')).decision, 'allow'); // not recursive, no secret file named
  assert.equal((await shell('ls -la')).decision, 'allow');
  assert.equal((await shell('grep -r API_KEY .env')).decision, 'deny'); // a named secret file stays a deny
});

test('a recursive shell search asks in every segment of the line, after a cd, behind wrappers, with quoted separators', async (t) => {
  const dir = tempDir(t, 'zn-agy-shellgrep2-');
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', '.env'), 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const ws = { workspacePaths: [dir] };
  const shell = async (line) => (await run(pre('run_command', { CommandLine: line, Cwd: dir }, ws))).output;
  const asks = [
    'grep -rn AWS config',
    'cd config && grep -rn AWS .',
    'cd config; rg AWS',
    '(cd config && grep -r AWS .)',
    'true; grep -rn AWS config',
    'echo hi && grep -rn AWS config',
    'cat a.txt | grep -r AWS config',
    'sudo grep -rn AWS config',
    'sudo -u root grep -rn AWS config',
    'env FOO=1 grep -r AWS config',
    'command grep -r AWS config',
    'nice -n 5 grep -r AWS config',
    'timeout 5 grep -r AWS config',
    'xargs grep -r AWS config',
    'git grep AWS config',
    'git -C config grep AWS',
    'grep -rE "AWS|KEY" config',
    "grep -rE 'a;b' config",
    'grep -rn -e AWS config',
    'grep -rn --include "*.js" AWS config',
    'cd config && rg -g "*.js" AWS',
  ];
  for (const line of asks) assert.equal((await shell(line)).decision, 'force_ask', line);
  for (const line of ['true; grep -rn AWS .', 'grep -rE "AWS|KEY" .', 'ls config', 'echo "grep -r AWS config"', 'cd config; ls', 'git grep AWS a.txt']) {
    // the folder itself has no .env, and a search that never reads config/ stays allowed
    const r = await shell(line);
    assert.notEqual(r.decision, 'deny', line);
  }
  assert.equal((await shell('grep -rE "AWS|KEY" .')).decision, 'allow');
  assert.equal((await shell('cd .. ; ls')).decision, 'allow');
});

test('a long chain of cd stays linear: it finishes fast and asks past the cap, never allows', async (t) => {
  const dir = tempDir(t, 'zn-agy-cdchain-');
  fs.mkdirSync(path.join(dir, 'd0'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const ws = { workspacePaths: [dir] };
  const chain = (n, tail) => Array.from({ length: n }, (_, i) => 'cd d' + i).join(' && ') + ' && ' + tail;
  const shell = async (line) => (await run(pre('run_command', { CommandLine: line, Cwd: dir }, ws))).output;
  // 40 cd segments: past the cap, so zn asks, and it does so quickly
  const t0 = Date.now();
  const many = await shell(chain(40, 'grep -r AWS .'));
  const ms = Date.now() - t0;
  assert.equal(many.decision, 'force_ask');
  assert.match(many.reason, /changes folders too many times/);
  assert.ok(ms < budget(1000), 'took ' + ms + ' ms');
  // a chain with a search path that is not a recursive search is not blocked by the cap
  assert.equal((await shell(chain(40, 'ls'))).decision, 'allow');
  // exactly at the cap (32 cd = 64 candidate folders) the search is still followed: clean folder allows
  assert.equal((await shell(chain(32, 'grep -r AWS .'))).decision, 'allow');
  // one more cd goes over the cap and asks
  const over = await shell(chain(33, 'grep -r AWS .'));
  assert.equal(over.decision, 'force_ask');
  assert.match(over.reason, /too many times/);
  // at the cap, a .env in a candidate folder still asks for that reason
  fs.writeFileSync(path.join(dir, 'd0', '.env'), 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n');
  const atCap = await shell(chain(32, 'grep -r AWS .'));
  assert.equal(atCap.decision, 'force_ask');
  assert.match(atCap.reason, /holds \.env/);
});

test('a recursive search reads one level of bash -c and asks on a path held in a variable', async (t) => {
  const dir = tempDir(t, 'zn-agy-shellc-');
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', '.env'), 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n');
  const ws = { workspacePaths: [dir] };
  const shell = async (line) => (await run(pre('run_command', { CommandLine: line, Cwd: dir }, ws))).output;
  for (const line of [
    'bash -c "grep -r AWS config"',
    "sh -c 'cd config && grep -r AWS .'",
    'sudo bash -lc "grep -rn AWS config"',
    'D=config; grep -r AWS $D',
    'grep -r AWS "$(echo config)"',
  ]) assert.equal((await shell(line)).decision, 'force_ask', line);
  for (const line of ['bash -c "ls config"', "sh -c 'echo hi'", 'bash -c "grep AWS a.txt"', 'D=config; ls $D']) {
    assert.equal((await shell(line)).decision, 'allow', line);
  }
  // a cd inside bash -c does not move the outer shell
  assert.equal((await shell('bash -c "cd config" && grep -r AWS .')).decision, 'allow');
});

test('a very long line is not allowed unread, and an unknown cd folder or a ~ path is followed', async (t) => {
  const dir = tempDir(t, 'zn-agy-long-');
  const home = tempDir(t, 'zn-agy-home-');
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', '.env'), 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n');
  fs.mkdirSync(path.join(home, 'proj', 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'proj', 'config', '.env'), 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n');
  const ws = { workspacePaths: [dir] };
  const shell = async (line) => (await run(pre('run_command', { CommandLine: line, Cwd: dir }, ws))).output;
  // 600 segments before the search: the rest cannot be read in time, so it asks
  const t0 = Date.now();
  const longLine = ':;'.repeat(600) + ' grep -rn AWS config';
  assert.equal((await shell(longLine)).decision, 'force_ask');
  assert.equal((await shell('cd d0 && '.repeat(260) + 'cd config && grep -rn AWS .')).decision, 'force_ask');
  assert.equal((await shell(':;'.repeat(600))).decision, 'force_ask');
  assert.ok(Date.now() - t0 < budget(1000), 'took ' + (Date.now() - t0) + ' ms');
  assert.equal((await shell(':;'.repeat(100) + ' grep -rn AWS config')).decision, 'force_ask'); // still read, and config holds .env
  assert.equal((await shell(':;'.repeat(100) + ' ls')).decision, 'allow');
  // a cd to a variable or a substitution leaves the folder unknown: the next recursive search asks
  for (const line of ['cd $D && grep -r AWS .', 'cd "$(echo config)" && grep -rn AWS .', 'cd `echo config` && grep -rn AWS .']) {
    assert.equal((await shell(line)).decision, 'force_ask', line);
  }
  assert.equal((await shell('cd $D && ls')).decision, 'allow');
  assert.equal((await shell('cd $D; grep AWS a.txt')).decision, 'allow'); // not recursive
  // ~ means the home folder the hook sees
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    assert.equal((await shell('grep -r AWS ~/proj/config')).decision, 'force_ask');
    assert.equal((await shell('cd ~/proj/config && grep -rn AWS .')).decision, 'force_ask');
    assert.equal((await shell('cd ~/proj && grep -rn AWS config')).decision, 'force_ask');
    assert.equal((await shell('grep -r AWS ~/nowhere')).decision, 'allow');
    // other tilde forms (~+, ~-, ~user) cannot be followed: a recursive search asks, a plain command does not
    for (const line of ['cd ~+/config && grep -rn AWS .', 'cd ~-/config && grep -rn AWS .', 'grep -r AWS ~user/x', 'grep -r AWS ~+/config']) {
      assert.equal((await shell(line)).decision, 'force_ask', line);
    }
    assert.equal((await shell('cd ~user && ls')).decision, 'allow');
    // on Windows ~\ is the home folder too (the platform is stubbed; the path is quoted so the shell keeps the backslash)
    const plat = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      assert.equal((await shell('grep -r AWS "~\\proj\\config"')).decision, 'force_ask');
      assert.equal((await shell('grep -r AWS "~\\nowhere"')).decision, 'allow');
    } finally {
      Object.defineProperty(process, 'platform', plat);
    }
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('install warns that a project hook needs zn on PATH, and that its backup must not be committed', (t) => {
  const dir = tempDir(t, 'zn-agy-warn-');
  const first = agy.install({ scope: 'project', projectDir: dir });
  assert.ok(first.warnings.some((w) => /needs zn-gate installed/.test(w)));
  const second = agy.install({ scope: 'project', projectDir: dir });
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

test('real tool names: IDE read_file/write_file/edit_file and CLI read_file use the read and write checks', async () => {
  const cred = path.join(HOME, '.ssh', 'id_rsa');
  assert.equal(agy.normalize(pre('read_file', { Path: cred })).tool, 'read');
  assert.equal(agy.normalize(pre('write_file', { Path: '/work/proj/a.txt', Content: 'x' })).tool, 'write');
  assert.equal(agy.normalize(pre('edit_file', { Path: '/work/proj/a.txt', Target: 'old', Replacement: 'new' })).tool, 'write');
  assert.equal((await run(pre('view_file', { AbsolutePath: cred }))).output.decision, 'deny');
  assert.equal((await run(pre('read_file', { Path: cred }))).output.decision, 'deny');
  assert.equal((await run(pre('read_file', { Path: '/work/proj/README.md' }))).output.decision, 'allow');
  assert.equal(agy.normalize(pre('list_dir', { DirectoryPath: '/work/proj' })).tool, 'read');
  assert.equal(agy.normalize(pre('find_by_name', { SearchDirectory: '/work/proj', Pattern: '*.js' })).tool, 'read');
  assert.equal((await run(pre('write_file', { Path: path.join(HOME, '.zn', 'vault.json'), Content: 'x' }))).output.decision, 'deny');
  assert.equal(agy.normalize(pre('run_command', { CommandLine: 'ls' })).tool, 'bash');
});

test('edit_file: the Target key is text, not a path', async () => {
  const n = agy.normalize(pre('edit_file', { Path: '/work/proj/a.js', Target: path.join(HOME, '.aws', 'credentials') }));
  assert.deepEqual(n.input.paths, ['/work/proj/a.js']);
  assert.equal((await run(pre('edit_file', { Path: '/work/proj/a.js', Target: 'const a = 1;', Replacement: 'const a = 2;' }))).output.decision, 'allow');
  // a call whose only candidate is Target has no readable path
  assert.equal(agy.normalize(pre('edit_file', { Target: 'x' })).unreadable !== undefined, true);
});

test('search_web, invoke_subagent and other tools without a path keep the default (no opinion)', async () => {
  for (const name of ['search_web', 'invoke_subagent', 'schedule', 'manage_task', 'ask_question', 'list_resources']) {
    assert.equal((await run(pre(name, { Query: 'x' }))).output.decision, 'allow', name);
  }
});

test('every real tool name, with its real argument shape, answers an explicit decision (never {} or nothing)', async () => {
  const cred = path.join(HOME, '.ssh', 'id_rsa');
  const shapes = [
    ['read_file', { Path: '/work/proj/a.txt' }], ['read_file', { Path: cred }], ['read_file', {}],
    ['write_file', { Path: '/work/proj/a.txt', Content: 'x' }], ['write_file', { Path: cred, Content: 'x' }], ['write_file', {}],
    ['edit_file', { Path: '/work/proj/a.txt', Target: 'old', Replacement: 'new' }], ['edit_file', { Target: 'old' }], ['edit_file', {}],
    ['run_command', { CommandLine: 'ls' }], ['run_command', { CommandLine: 'cat ' + cred }], ['run_command', {}],
    ['view_file', { AbsolutePath: '/work/proj/a.txt' }], ['write_to_file', { TargetFile: '/work/proj/a.txt', CodeContent: 'x' }],
    ['find_by_name', { SearchDirectory: '/work/proj', Pattern: '*.js' }], ['list_dir', { DirectoryPath: '/work/proj' }],
    ['invoke_subagent', { Task: 'x' }], ['search_web', { query: 'x' }], ['schedule', {}], ['manage_task', {}], ['ask_question', {}], ['list_resources', {}],
  ];
  for (const [name, args] of shapes) {
    const r = await run(pre(name, args));
    assert.ok(r.output && VALID.has(r.output.decision), name + ' ' + JSON.stringify(args) + ' -> ' + JSON.stringify(r.output));
    if (r.output.decision === 'deny') assert.ok(r.output.reason, name + ': a deny carries a reason');
    assert.notDeepEqual(r.output, {}, name);
  }
});

test('edit_file: Target is never taken for the file, also nested; write_to_file TargetFile still is', () => {
  const n = agy.normalize(pre('edit_file', { Path: '/work/proj/a.js', Target: path.join(HOME, '.aws', 'credentials'), Edit: { Target: '/etc/passwd', Path: '/work/proj/b.js' } }));
  assert.deepEqual(n.input.paths, ['/work/proj/a.js', '/work/proj/b.js']);
  assert.deepEqual(agy.normalize(pre('write_to_file', { TargetFile: '/work/proj/a.txt', CodeContent: 'x' })).input.paths, ['/work/proj/a.txt']);
});

// The real hook process: a hung check, an escaped error and unreadable input all end in a deny on stdout.
const { spawnSync } = require('child_process');
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

function spawnHook(t, input, fault) {
  const home = tempDir(t, 'zn-agy-hook-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off' };
  delete env.ZN_TEST_HOOK_FAULTS;
  if (fault) { env.ZN_TEST_HOOK_FAULTS = '1'; Object.assign(env, fault); }
  const started = Date.now();
  const r = spawnSync(process.execPath, [RUNNER, 'antigravity'], { input, encoding: 'utf8', env, timeout: 20000 });
  return { ...r, ms: Date.now() - started };
}

function assertDeny(r) {
  const o = JSON.parse(r.stdout); // stdout is nothing but this JSON
  assert.equal(o.decision, 'deny', r.stdout + r.stderr);
  assert.ok(o.reason && o.reason.length > 10);
  assert.ok(!/\bat .*\.js:\d+/.test(r.stdout), 'no stack trace on stdout');
}

test('the real hook: a hung check is answered with a deny before Antigravity gives up', (t) => {
  const r = spawnHook(t, JSON.stringify(pre('run_command', { CommandLine: 'ls' })), { ZN_TEST_HOOK_FAULT: 'hang', ZN_TEST_HOOK_HANG_MS: '30000', ZN_TEST_HOOK_DEADLINE_MS: '800' });
  assertDeny(r);
  assert.equal(r.status, 2);
  assert.ok(r.ms < 8000, 'answered in ' + r.ms + ' ms');
  assert.ok(agy.HOOK_TIMEOUT_S >= 10, 'the watchdog (timeout minus 5 s) is not zero');
});

test('the real hook: an error that escapes, or a rejected promise, is answered with a deny', (t) => {
  for (const f of ['crash', 'reject']) {
    const r = spawnHook(t, JSON.stringify(pre('run_command', { CommandLine: 'ls' })), { ZN_TEST_HOOK_FAULT: f, ZN_TEST_HOOK_HANG_MS: '5000' });
    assertDeny(r);
  }
  // a throw inside the check is caught by the runner itself: a deny too
  assertDeny(spawnHook(t, JSON.stringify(pre('run_command', { CommandLine: 'ls' })), { ZN_TEST_HOOK_FAULT: 'throw' }));
});

test('the real hook: unreadable input (empty, not JSON, not an object) is a deny; a normal call is an allow', (t) => {
  for (const input of ['', 'not json', '[1]', '42']) assertDeny(spawnHook(t, input));
  const ok = spawnHook(t, JSON.stringify(pre('search_web', { query: 'x' })));
  assert.equal(JSON.parse(ok.stdout).decision, 'allow');
  assert.equal(ok.status, 0);
});

test('the real hook: the test variables do nothing without ZN_TEST_HOOK_FAULTS=1', (t) => {
  const r = spawnHook(t, JSON.stringify(pre('search_web', { query: 'x' })), null);
  assert.equal(JSON.parse(r.stdout).decision, 'allow');
  const env2 = spawnSync(process.execPath, [RUNNER, 'antigravity'], { input: JSON.stringify(pre('search_web', { query: 'x' })), encoding: 'utf8', env: { ...process.env, ZN_STATS: 'off', ZN_TEST_HOOK_FAULT: 'hang', ZN_TEST_HOOK_HANG_MS: '30000', ZN_TEST_HOOK_DEADLINE_MS: '100', ZN_TEST_HOOK_FAULTS: '' }, timeout: 20000 });
  assert.equal(JSON.parse(env2.stdout).decision, 'allow');
});
