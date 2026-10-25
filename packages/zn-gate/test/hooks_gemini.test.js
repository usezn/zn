'use strict';

process.env.ZN_STATS = 'off';

// Gemini CLI hooks: fixtures follow the documented contract (https://geminicli.com/docs/hooks/ and
// https://geminicli.com/docs/hooks/reference/, read 2026-10-19); there is no Gemini CLI binary here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter, listAdapters } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const gem = getAdapter('gemini');
const HOME = process.env.HOME || '/home/u';
const FIXTURES = path.join(__dirname, 'fixtures', 'gemini-cli');
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

function bt(tool_name, tool_input, extra = {}) {
  return { session_id: 's1', transcript_path: '/t.json', cwd: '/work/proj', hook_event_name: 'BeforeTool', timestamp: '2026-10-19T10:00:00.000Z', tool_name, tool_input, ...extra };
}

function run(raw) {
  return runner.handle(gem, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
}

const settingsOf = (home) => path.join(home, '.gemini', 'settings.json');
const readSettings = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('registry lists gemini and accepts the gemini-cli alias', () => {
  assert.ok(listAdapters().includes('gemini'));
  assert.equal(getAdapter('gemini-cli').id, 'gemini');
});

/* ---------------------- contract fixtures (stdin -> stdout) ---------------------- */

const names = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.in.json')).map((f) => f.replace(/\.in\.json$/, ''));

test('there is a fixture for BeforeTool, AfterTool and SessionStart', () => {
  assert.ok(names.length >= 10);
  for (const ev of ['BeforeTool', 'AfterTool', 'SessionStart']) {
    assert.ok(names.some((n) => JSON.parse(fs.readFileSync(path.join(FIXTURES, n + '.in.json'), 'utf8')).hook_event_name === ev), ev);
  }
});

for (const name of names) {
  test('fixture ' + name, async () => {
    const read = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8').split('${HOME}').join(HOME.replace(/\\/g, '/')));
    const input = read(name + '.in.json');
    const want = read(name + '.out.json');
    const r = await run(input);
    if (want === null) {
      assert.equal(r.output, null, 'no opinion means no output: ' + JSON.stringify(r.output));
      return;
    }
    assert.equal(r.output.decision, want.decision);
    assert.deepEqual(Object.keys(r.output).sort(), ['decision', 'reason']);
    assert.ok(typeof r.output.reason === 'string' && r.output.reason.length > 0);
    if (want.reason !== '*') assert.ok(r.output.reason.includes(want.reason), r.output.reason);
  });
}

test('zn never emits an allow, an approve or a rewritten input', async () => {
  for (const n of names) {
    const raw = fs.readFileSync(path.join(FIXTURES, n + '.in.json'), 'utf8').split('${HOME}').join(HOME.replace(/\\/g, '/'));
    const r = await run(JSON.parse(raw));
    const s = JSON.stringify(r.output);
    assert.ok(!/"allow"|"approve"|tool_input|hookSpecificOutput|systemMessage/.test(s), n + ': ' + s);
  }
});

/* ------------------------------- normalize ------------------------------- */

test('normalize: shell command, dir_path moves the working folder', () => {
  const n = gem.normalize(bt('run_shell_command', { command: 'ls -la', dir_path: 'sub' }));
  assert.equal(n.event, 'pre_tool');
  assert.equal(n.tool, 'bash');
  assert.equal(n.input.command, 'ls -la');
  assert.equal(n.cwd, path.resolve('/work/proj', 'sub'));
  assert.equal(gem.normalize(bt('run_shell_command', { command: 'ls' })).cwd, '/work/proj');
});

test('normalize: file tools, search tools and web_fetch', () => {
  assert.equal(gem.normalize(bt('read_file', { file_path: '/a/b' })).tool, 'read');
  assert.equal(gem.normalize(bt('write_file', { file_path: '/a/b', content: '.env' })).tool, 'write');
  const rep = gem.normalize(bt('replace', { file_path: '/a/b', old_string: '/etc/shadow', new_string: 'x' }));
  assert.deepEqual(rep.input.paths, ['/a/b'], 'content-like arguments are not paths');
  const g = gem.normalize(bt('grep_search', { pattern: 'x', dir_path: 'src' }));
  assert.equal(g.tool, 'grep');
  assert.equal(g.input.scanDir, path.resolve('/work/proj', 'src'));
  assert.equal(gem.normalize(bt('search_file_content', { pattern: 'x' })).tool, 'grep');
  assert.equal(gem.normalize(bt('web_fetch', { prompt: 'summarize https://example.com/a' })).tool, 'webfetch');
});

test('normalize: MCP names, other events and junk', () => {
  const m = gem.normalize(bt('mcp_sql_query', { q: 'x' }));
  assert.equal(m.tool, 'mcp');
  assert.deepEqual(m.mcp, { server: 'sql', tool: 'query' });
  const m2 = gem.normalize(bt('mcp_my_server_do_it', { q: 'x' }, { mcp_context: { server_name: 'my_server', tool_name: 'do_it' } }));
  assert.deepEqual(m2.mcp, { server: 'my_server', tool: 'do_it' });
  assert.equal(gem.normalize({ ...bt('x', {}), hook_event_name: 'AfterTool' }).event, null);
  assert.equal(gem.normalize({ hook_event_name: 'SessionStart', source: 'startup' }).event, null);
  assert.equal(gem.normalize(null), null);
});

/* ------------------------------ decisions ------------------------------- */

test('fail closed: file tools without a path, a shell call without a command, a call without a tool name', async () => {
  for (const [name, args] of [['read_file', {}], ['write_file', { content: 'x' }], ['replace', { old_string: 'a' }], ['run_shell_command', { description: 'x' }], ['', { file_path: '/a' }]]) {
    const r = await run(bt(name, args));
    assert.equal(r.output.decision, 'deny', name);
    assert.ok(r.output.reason);
  }
  assert.equal((await run(bt('glob', { pattern: '*.js' }))).output, null, 'names only: no opinion');
});

test('unknown tools that name a file get the read and write checks on every path', async () => {
  const cred = path.join(HOME, '.aws', 'credentials');
  assert.equal((await run(bt('future_viewer', { file_path: cred }))).output.decision, 'deny');
  assert.equal((await run(bt('future_editor', { edits: [{ file_path: '/work/proj/ok.js' }, { file_path: path.join(HOME, '.gemini', 'settings.json') }] }))).output.decision, 'deny');
  assert.equal((await run(bt('mystery', { q: 1 }))).output, null);
});

test('reads check every path of the call, not only the first', async () => {
  const r = await run(bt('read_many_files', { include: ['/work/proj/ok.txt', path.join(HOME, '.aws', 'credentials')] }));
  assert.equal(r.output.decision, 'deny');
});

test('a command with a secret placeholder in its arguments is blocked with the environment-variable way; the command is never rewritten', async () => {
  const r = await run(bt('run_shell_command', { command: 'curl -H "Authorization: __ZN_API_KEY__" https://example.com' }));
  assert.equal(r.output.decision, 'deny');
  assert.match(r.output.reason, /run --secrets NAME -- <command>/);
  assert.equal(r.output.hookSpecificOutput, undefined);
});

test('deny: the agent cannot edit the files that switch the hook off', async () => {
  for (const f of [path.join(HOME, '.gemini', 'settings.json'), '/work/proj/.gemini/settings.json', '/etc/gemini-cli/settings.json']) {
    assert.equal((await run(bt('write_file', { file_path: f, content: '{}' }))).output.decision, 'deny', f);
  }
  assert.equal((await run(bt('run_shell_command', { command: 'echo {} > .gemini/settings.json' }))).output.decision, 'deny');
  assert.equal((await run(bt('run_shell_command', { command: 'sed -i s/a/b/ ~/.gemini/settings.json' }))).output.decision, 'deny');
});

test('a command already wrapped in zn run, or one with a restorable token, gets no opinion (Gemini CLI approval applies)', async () => {
  const wrapped = await run(bt('run_shell_command', { command: 'zn run -- node -e "console.log(1)" __ZN_DB_PASSWORD__' }));
  assert.equal(wrapped.output, null);
  assert.equal(wrapped.decision.decision, 'ask');
});

test('a search over a folder that holds a plain-text .env is blocked (Gemini hooks cannot ask); a clean folder is not', async (t) => {
  const dir = tempDir(t, 'zn-gem-grep-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  assert.equal((await run(bt('grep_search', { pattern: 'x', dir_path: dir }))).output, null);
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=sk_live_abcdefghijklmnop1234\n');
  const r = await run(bt('grep_search', { pattern: 'x', dir_path: dir }));
  assert.equal(r.output.decision, 'deny');
  assert.match(r.output.reason, /\.env/);
  assert.match(r.output.reason, /cannot show that question/);
  assert.match(r.output.reason, /narrower path/);
});

test('an unreadable hook input is refused with exit code 2 and the reason on stderr (the documented block)', (t) => {
  const home = tempDir(t, 'zn-gem-run-');
  for (const input of ['', 'not json', '[1]']) {
    const r = spawnSync(process.execPath, [RUNNER, 'gemini'], { input, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off' } });
    assert.equal(r.status, 2, JSON.stringify(input));
    assert.match(r.stderr, /could not read this action/);
    // The deny JSON goes to stdout as well (the Windows launcher passes the refusal on as exit 0); never other text.
    assert.deepEqual(JSON.parse(r.stdout).decision, 'deny');
  }
});

/* --------------------------- install / uninstall -------------------------- */

test('install (project): BeforeTool group with a named command hook in milliseconds; idempotent; uninstall removes the file content', (t) => {
  const dir = tempDir(t, 'zn-gem-');
  const rep = gem.install({ scope: 'project', projectDir: dir });
  const file = path.join(dir, '.gemini', 'settings.json');
  assert.equal(rep.settings, file);
  const data = readSettings(file);
  assert.deepEqual(Object.keys(data), ['hooks']);
  assert.deepEqual(Object.keys(data.hooks), ['BeforeTool']);
  const [g] = data.hooks.BeforeTool;
  assert.equal(g.matcher, '*');
  assert.equal(g.hooks.length, 1);
  assert.deepEqual({ ...g.hooks[0], command: undefined }, { name: 'zn-gate', type: 'command', command: undefined, timeout: 15000 });
  assert.ok(require('../lib/agents/launcher').isProjectGuard(g.hooks[0].command, 'gemini'));
  gem.install({ scope: 'project', projectDir: dir });
  assert.equal(readSettings(file).hooks.BeforeTool.length, 1);
  assert.equal(gem.uninstall({ scope: 'project', projectDir: dir }).removed, 1);
  assert.deepEqual(readSettings(file), {});
  assert.equal(gem.uninstall({ scope: 'project', projectDir: dir }).removed, 0);
});

test('install (user) backs up, keeps every other setting and hook, and uninstall removes only zn', { skip: process.platform === 'win32' }, (t) => {
  const home = tempDir(t, 'zn-gem-home-');
  const file = settingsOf(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = {
    theme: 'dark',
    hooksConfig: { enabled: true, disabled: ['theirs-off'] },
    hooks: {
      BeforeTool: [{ matcher: 'write_file', hooks: [{ name: 'theirs', type: 'command', command: './mine.sh' }] }],
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: './hello.sh' }] }],
    },
  };
  fs.writeFileSync(file, JSON.stringify(mine));
  const rep = gem.install({ scope: 'user', home, nodePath: '/usr/bin/node' });
  assert.ok(rep.backup && fs.existsSync(rep.backup));
  assert.deepEqual(JSON.parse(fs.readFileSync(rep.backup, 'utf8')), mine);
  let data = readSettings(file);
  assert.equal(data.theme, 'dark');
  assert.deepEqual(data.hooksConfig, mine.hooksConfig);
  assert.deepEqual(data.hooks.SessionStart, mine.hooks.SessionStart);
  assert.deepEqual(data.hooks.BeforeTool[0], mine.hooks.BeforeTool[0]);
  assert.match(data.hooks.BeforeTool[1].hooks[0].command, /\/\.zn\/hooks\/zn-hook-gemini\.sh' BeforeTool$/);
  gem.uninstall({ scope: 'user', home });
  data = readSettings(file);
  assert.deepEqual(data, mine);
});

test('install keeps a foreign hook that shares a group with zn, and removes an older zn hook', (t) => {
  const home = tempDir(t, 'zn-gem-shared-');
  const file = settingsOf(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const theirs = { type: 'command', command: './theirs.sh' };
  fs.writeFileSync(file, JSON.stringify({ hooks: { BeforeTool: [{ matcher: '*', hooks: [theirs, { type: 'command', command: '"/old/node" "/old/zn-gate/lib/hooks/runner.js" gemini' }] }] } }));
  gem.install({ scope: 'user', home, nodePath: '/usr/bin/node' });
  const list = readSettings(file).hooks.BeforeTool;
  assert.deepEqual(list[0].hooks, [theirs]);
  assert.equal(list.length, 2);
  gem.uninstall({ scope: 'user', home });
  assert.deepEqual(readSettings(file).hooks.BeforeTool, [{ matcher: '*', hooks: [theirs] }]);
});

test('install and uninstall refuse a settings file or a hooks field of the wrong shape and leave it alone', (t) => {
  const dir = tempDir(t, 'zn-gem-bad-');
  const file = path.join(dir, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const text of ['[1]', '{"hooks": []}', '{"hooks": {"BeforeTool": {}}}', '{ not json']) {
    fs.writeFileSync(file, text);
    assert.throws(() => gem.install({ scope: 'project', projectDir: dir }), undefined, text);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

test('install on Windows (user scope) writes the powershell form; project scope is zn on the PATH inside the start guard', (t) => {
  const home = tempDir(t, 'zn-gem-win-');
  gem.install({ scope: 'user', home, platform: 'win32', nodePath: 'C:/Program Files/nodejs/node.exe', runnerPath: 'C:/zn/zn-gate/lib/hooks/runner.js' });
  const winCommand = readSettings(settingsOf(home)).hooks.BeforeTool[0].hooks[0].command;
  assert.match(winCommand, /^powershell\.exe /);
  assert.match(require('../lib/shell-quote').windowsCommandScript(winCommand), /runner\.js.* gemini; if \(\(\$LASTEXITCODE -eq 0 -and \(zk\)\) -or \$LASTEXITCODE -eq 2\) \{ zx/);
  const dir = tempDir(t, 'zn-gem-win-p-');
  gem.install({ scope: 'project', projectDir: dir, platform: 'win32' });
  const projWin = readSettings(path.join(dir, '.gemini', 'settings.json')).hooks.BeforeTool[0].hooks[0].command;
  assert.match(projWin, /^powershell\.exe /);
  assert.ok(require('../lib/agents/launcher').isProjectWindowsScript(require('../lib/shell-quote').windowsCommandScript(projWin), 'gemini'));
});

test('install warnings: experimental, fail-open on crash, no asking and no scrubbing, project trust, how it is turned off', (t) => {
  const dir = tempDir(t, 'zn-gem-warn-');
  const first = gem.install({ scope: 'project', projectDir: dir });
  const all = first.warnings.join('\n');
  assert.match(all, /experimental/);
  assert.match(all, /only exit code 2 blocks/);
  assert.match(all, /cannot ask the user/);
  assert.match(all, /not hidden/);
  assert.match(all, /untrusted until the user approves/);
  assert.match(all, /hooksConfig\.enabled/);
  assert.ok(gem.install({ scope: 'project', projectDir: dir }).warnings.some((w) => /do not commit it/.test(w)));
  assert.equal(gem.install({ scope: 'user', home: dir, nodePath: '/usr/bin/node' }).warnings.some((w) => /untrusted until/.test(w)), false);
});

/* ------------------------------ zn-gate check ----------------------------- */

test('zn-gate check reads the Gemini CLI install state (absent, set up) and runs the installed hook', async (t) => {
  const check = require('../lib/check');
  const home = tempDir(t, 'zn-gem-check-');
  const cwd = tempDir(t, 'zn-gem-check-cwd-');
  const env = { ...process.env, HOME: home };
  const sys = path.join(home, 'no-system.json');
  const find = async (live) => (await check.check({ home, cwd, env, live, geminiSystemFile: sys })).results.find((r) => r.id === 'gemini');
  assert.equal((await find(false)).state, 'not-set-up');
  gem.install({ scope: 'user', home, nodePath: process.execPath });
  const setup = await find(false);
  assert.notEqual(setup.state, 'not-set-up');
  const live = await find(true);
  assert.equal(live.state, 'protected', live.problem);
  assert.equal(live.verified, true);
});

test('zn-gate check warns when settings turn hooks off or list zn in hooksConfig.disabled (user, project, system)', async (t) => {
  const check = require('../lib/check');
  const home = tempDir(t, 'zn-gem-pol-');
  const cwd = tempDir(t, 'zn-gem-pol-cwd-');
  const env = { ...process.env, HOME: home };
  const sys = path.join(home, 'system-settings.json');
  gem.install({ scope: 'user', home, nodePath: process.execPath });
  const find = async () => (await check.check({ home, cwd, env, live: true, geminiSystemFile: sys })).results.find((r) => r.id === 'gemini');
  assert.equal((await find()).state, 'protected');

  const user = readSettings(settingsOf(home));
  fs.writeFileSync(settingsOf(home), JSON.stringify({ ...user, hooksConfig: { enabled: false } }));
  let r = await find();
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /hooksConfig\.enabled is false/);
  assert.match(r.fix, /Gemini CLI setting/);

  fs.writeFileSync(settingsOf(home), JSON.stringify({ ...user, hooksConfig: { disabled: ['zn-gate'] } }));
  r = await find();
  assert.match(r.problem, /hooksConfig\.disabled/);

  fs.writeFileSync(settingsOf(home), JSON.stringify(user));
  fs.mkdirSync(path.join(cwd, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.gemini', 'settings.json'), '// project\n{ "hooksConfig": { "enabled": false, }, }');
  r = await find();
  assert.match(r.problem, /this folder/);
  fs.rmSync(path.join(cwd, '.gemini'), { recursive: true });

  fs.writeFileSync(sys, JSON.stringify({ hooksConfig: { disabled: ['./other.sh', '"/x/node" "/x/zn-gate/lib/hooks/runner.js" gemini'] } }));
  r = await find();
  assert.match(r.problem, /system Gemini CLI settings/);

  fs.writeFileSync(sys, '{ broken');
  r = await find();
  assert.equal(r.state, 'protected');
  assert.ok(r.notes.some((n) => /could not read/.test(n)));
});

test('geminiPolicyWarnings: nothing for settings that leave hooks on', (t) => {
  const { geminiPolicyWarnings } = require('../lib/agents/managed-policy');
  const dir = tempDir(t, 'zn-gem-pw-');
  const f = path.join(dir, 's.json');
  fs.writeFileSync(f, JSON.stringify({ hooksConfig: { enabled: true, disabled: ['other'] }, tools: { enableHooks: true } }));
  assert.deepEqual(geminiPolicyWarnings({ files: [{ file: f, label: 'x' }, { file: path.join(dir, 'missing.json'), label: 'y' }] }), []);
});
