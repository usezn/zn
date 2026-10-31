'use strict';

process.env.ZN_STATS = 'off';

// ZCode desktop app hooks: fixtures follow the contract in the ZCode docs (https://zcode.z.ai/en/docs/hooks, read 2026-10-24): stdin carries both camelCase fields and the snake_case
// aliases, and an answer must pass ZCode's own output schema or the hook fails and the tool runs. There is no
// ZCode binary here; the answers are checked against a copy of that schema (validZCodeOutput).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter, listAdapters } = require('../lib/agents');
const cfg = require('../lib/agents/config-file');
const launcher = require('../lib/agents/launcher');
const runner = require('../lib/hooks/runner');
const policy = require('../lib/hooks/policy');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');
const { WIN, SH, fwd, shEnv } = require('./helpers/git_bash');

const zc = getAdapter('zcode');
const HOME = process.env.HOME || require('os').homedir(); // the fixtures name ~/.zn: the home zn itself uses (no HOME on Windows)
const FIXTURES = path.join(__dirname, 'fixtures', 'zcode');
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const posix = process.platform !== 'win32';
// On Windows ZCode gets a powershell.exe process hook, not the sh launcher: tests that run the sh launcher itself use sh from Git Bash.
const needSh = !SH && 'needs sh (Git Bash on Windows)';
const spawnLauncher = (file, args, opts) => (WIN ? spawnSync(SH, [fwd(file), ...args], { ...opts, env: shEnv(opts.env) }) : spawnSync(file, args, opts));

function run(raw) {
  return runner.handle(zc, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
}

const cliFile = (home) => path.join(home, '.zcode', 'cli', 'config.json');
const readCfg = (home) => JSON.parse(fs.readFileSync(cliFile(home), 'utf8'));
const write = (home, obj) => {
  fs.mkdirSync(path.dirname(cliFile(home)), { recursive: true });
  fs.writeFileSync(cliFile(home), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
};

// The hook output contract in the official ZCode hooks documentation (https://zcode.z.ai/en/docs/hooks), reduced to the keys zn uses.
function validZCodeOutput(out, event) {
  assert.ok(out && typeof out === 'object' && !Array.isArray(out));
  const top = new Set(['additionalContext', 'additional_context', 'continue', 'decision', 'hookSpecificOutput', 'reason', 'stopReason', 'suppressOutput', 'systemMessage']);
  for (const k of Object.keys(out)) assert.ok(top.has(k), 'unknown key ' + k);
  if (out.continue !== undefined) assert.equal(typeof out.continue, 'boolean');
  if (out.reason !== undefined) assert.equal(typeof out.reason, 'string');
  if (out.decision !== undefined) assert.ok(['approve', 'block'].includes(out.decision));
  const s = out.hookSpecificOutput;
  if (s === undefined) return;
  assert.equal(s.hookEventName, event, 'the event name must match, or the hook fails');
  if (event === 'PreToolUse') {
    assert.deepEqual(Object.keys(s).filter((k) => !['hookEventName', 'permissionDecision', 'permissionDecisionReason', 'updatedInput', 'additionalContext'].includes(k)), []);
    if (s.permissionDecision !== undefined) assert.ok(['allow', 'ask', 'deny'].includes(s.permissionDecision));
  } else if (event === 'PermissionRequest') {
    assert.deepEqual(Object.keys(s).sort(), ['decision', 'hookEventName']);
    assert.equal(s.decision.behavior, 'deny');
    assert.ok(Object.keys(s.decision).every((k) => ['behavior', 'interrupt', 'message'].includes(k)));
  } else {
    assert.deepEqual(Object.keys(s).filter((k) => !['hookEventName', 'additionalContext'].includes(k)), []);
  }
}

test('registry lists zcode and accepts the zai alias', () => {
  assert.ok(listAdapters().includes('zcode'));
  assert.equal(getAdapter('ZCode').id, 'zcode');
  assert.equal(getAdapter('zai').id, 'zcode');
});

/* ---------------------- contract fixtures (stdin -> stdout) ---------------------- */

const names = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.in.json')).map((f) => f.replace(/\.in\.json$/, ''));
const readFixture = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8').split('${HOME}').join(HOME.replace(/\\/g, '/')));

test('there are fixtures for every event zn registers and for events it ignores', () => {
  const events = new Set(names.map((n) => readFixture(n + '.in.json').hook_event_name));
  for (const ev of [...zc.EVENTS, 'SessionStart', 'Stop']) assert.ok(events.has(ev), ev);
  // Both spellings are in every payload, as ZCode sends them.
  for (const n of names) {
    const i = readFixture(n + '.in.json');
    assert.equal(i.hookEventName, i.hook_event_name, n);
    assert.equal(i.sessionId, i.session_id, n);
  }
});

for (const name of names) {
  test('fixture ' + name, async () => {
    const input = readFixture(name + '.in.json');
    const want = readFixture(name + '.out.json');
    const r = await run(input);
    if (want === null) {
      assert.equal(r.output, null, 'no opinion means no output: ' + JSON.stringify(r.output));
      return;
    }
    validZCodeOutput(r.output, want.shape === 'prompt_block' ? 'UserPromptSubmit' : want.shape === 'post_notice' ? 'PostToolUse' : input.hook_event_name);
    const text = JSON.stringify(r.output);
    if (want.shape === 'pre_deny') {
      assert.equal(r.output.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(r.output.hookSpecificOutput.permissionDecisionReason);
    } else if (want.shape === 'perm_deny') {
      assert.equal(r.output.hookSpecificOutput.decision.behavior, 'deny');
    } else if (want.shape === 'prompt_block') {
      assert.equal(r.output.continue, false);
      assert.ok(r.output.reason);
    } else if (want.shape === 'post_notice') {
      assert.match(r.output.hookSpecificOutput.additionalContext, /ZCode cannot hide tool output/);
      assert.ok(!/AKIAIOSFODNN7EXAMPLE|__ZN_/.test(text), 'the notice never repeats the value or a token');
    }
    if (want.reason) assert.ok(text.includes(want.reason), text);
  });
}

test('zn never emits an allow, a rewritten input or an approval', async () => {
  for (const n of names) {
    const r = await run(readFixture(n + '.in.json'));
    const s = JSON.stringify(r.output);
    assert.ok(!/"allow"|"approve"|updatedInput|updatedPermissions|"ask"/.test(s), n + ': ' + s);
  }
});

/* ------------------------------- normalize ------------------------------- */

const pre = (toolName, toolInput, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/work/proj', tool_name: toolName, tool_input: toolInput, ...extra });

test('normalize: built-in tools map to zn tool kinds', () => {
  assert.deepEqual([zc.normalize(pre('Bash', { command: 'ls' })).tool, zc.normalize(pre('Bash', { command: 'ls' })).input.command], ['bash', 'ls']);
  assert.equal(zc.normalize(pre('Read', { file_path: '/a/b' })).tool, 'read');
  assert.equal(zc.normalize(pre('Write', { file_path: '/a/b', content: '/etc/shadow' })).tool, 'write');
  const e = zc.normalize(pre('Edit', { file_path: '/a/b', old_string: '/etc/shadow', new_string: 'x' }));
  assert.equal(e.tool, 'edit');
  assert.deepEqual(e.input.paths, ['/a/b'], 'content-like arguments are not paths');
  const g = zc.normalize(pre('Grep', { pattern: 'x', path: 'src' }));
  assert.equal(g.tool, 'grep');
  assert.equal(g.input.scanDir, path.resolve('/work/proj', 'src'));
  assert.equal(zc.normalize(pre('Grep', { pattern: 'x' })).input.scanDir, '/work/proj');
  assert.equal(zc.normalize(pre('WebFetch', { url: 'https://example.com', prompt: 'p' })).input.url, 'https://example.com');
  assert.equal(zc.normalize(pre('Glob', { pattern: '*' })).tool, 'glob');
});

test('normalize: ApplyPatch lists every file of the patch; an unreadable patch is flagged', () => {
  const p = '*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n*** Delete File: b.txt\n*** End Patch';
  const n = zc.normalize(pre('ApplyPatch', { patch_text: p }));
  assert.equal(n.tool, 'write');
  assert.deepEqual(n.input.paths, ['a.txt', 'b.txt']);
  assert.equal(n.input.unparsed, false);
  assert.equal(zc.normalize(pre('ApplyPatch', { patch_text: 'no markers at all' })).input.unparsed, true);
  assert.ok(zc.normalize(pre('ApplyPatch', {})).unreadable);
});

test('normalize: MCP names, the camelCase spelling alone, other events and junk', () => {
  const m = zc.normalize(pre('mcp__sql__query', { q: 'x' }));
  assert.equal(m.tool, 'mcp');
  assert.deepEqual(m.mcp, { server: 'sql', tool: 'query' });
  assert.deepEqual(m.input.args, { q: 'x' });
  const camel = zc.normalize({ hookEventName: 'PreToolUse', sessionId: 's', cwd: '/w', toolName: 'Bash', toolInput: { command: 'ls' } });
  assert.equal(camel.event, 'pre_tool');
  assert.equal(camel.input.command, 'ls');
  assert.equal(zc.normalize({ hook_event_name: 'SessionStart' }).event, null);
  assert.equal(zc.normalize({ hook_event_name: 'Stop' }).event, null);
  assert.equal(zc.normalize({ hook_event_name: 'PostToolUseFailure' }).event, null);
  assert.equal(zc.normalize(null), null);
  assert.equal(zc.normalize([1]), null);
  const perm = zc.normalize({ ...pre('Bash', { command: 'ls' }), hook_event_name: 'PermissionRequest' });
  assert.equal(perm.event, 'pre_tool');
  assert.equal(perm.permissionRequest, true);
});

test('normalize: PostToolUse keeps tool_response only for the tools whose output zn checks', () => {
  const post = (name, resp) => zc.normalize({ hook_event_name: 'PostToolUse', cwd: '/w', tool_name: name, tool_input: {}, tool_response: resp });
  assert.deepEqual([post('Bash', { stdout: 'x' }).tool, post('Read', 'x').tool, post('Grep', 'x').tool, post('mcp__a__b', 'x').tool], ['bash', 'read', 'grep', 'mcp']);
  assert.equal(post('Write', 'x').tool, 'write');
  assert.deepEqual(post('Bash', { stdout: 'x' }).output, { stdout: 'x' });
});

/* ------------------------------ decisions ------------------------------- */

test('fail closed: file tools without a path, a shell call without a command, a call without a tool name', async () => {
  for (const [name, args] of [['Read', {}], ['Write', { content: 'x' }], ['Edit', { old_string: 'a' }], ['Bash', { description: 'x' }], ['', { file_path: '/a' }], ['ApplyPatch', {}]]) {
    const r = await run(pre(name, args));
    assert.equal(r.output.hookSpecificOutput.permissionDecision, 'deny', name);
  }
  // PermissionRequest gets its own deny shape for the same cases.
  const p = await run({ ...pre('Read', {}), hook_event_name: 'PermissionRequest' });
  assert.equal(p.output.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal((await run(pre('Glob', { pattern: '*.js' }))).output, null, 'names only: no opinion');
});

test('a search over a folder with a plain-text .env asks the user (PreToolUse supports ask); a clean folder does not', async (t) => {
  const dir = tempDir(t, 'zn-zc-grep-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  assert.equal((await run(pre('Grep', { pattern: 'x', path: dir }))).output, null);
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=sk_live_abcdefghijklmnop1234\n');
  const r = await run(pre('Grep', { pattern: 'x', path: dir }));
  validZCodeOutput(r.output, 'PreToolUse');
  assert.equal(r.output.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(r.output.hookSpecificOutput.permissionDecisionReason, /\.env/);
  // PermissionRequest never answers an ask: the prompt stays as it is.
  assert.equal((await run({ ...pre('Grep', { pattern: 'x', path: dir }), hook_event_name: 'PermissionRequest' })).output, null);
});

test('a command already wrapped in zn run asks the user; PermissionRequest stays silent', async () => {
  const cmd = 'zn run -- node -e "console.log(1)" __ZN_DB_PASSWORD__';
  const wrapped = await run(pre('Bash', { command: cmd }));
  assert.equal(wrapped.decision.decision, 'ask');
  validZCodeOutput(wrapped.output, 'PreToolUse');
  assert.equal(wrapped.output.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(wrapped.output.hookSpecificOutput.updatedInput, undefined, 'the command is never rewritten');
  assert.equal((await run({ ...pre('Bash', { command: cmd }), hook_event_name: 'PermissionRequest' })).output, null);
});

test('the agent cannot edit or print the files that switch the hook off or hold its provider key', async () => {
  const conf = path.join(HOME, '.zcode', 'cli', 'config.json');
  assert.equal((await run(pre('Write', { file_path: conf, content: '{}' }))).output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await run(pre('Bash', { command: 'echo {} > ~/.zcode/cli/config.json' }))).output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await run(pre('Bash', { command: 'sed -i s/true/false/ ~/.zcode/cli/config.json' }))).output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await run(pre('Read', { file_path: path.join(HOME, '.zcode', 'v2', 'provider_config.json') }))).output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await run(pre('Read', { file_path: '/work/proj/.zcode/notes.md' }))).output, null);
});

test('unknown tools that name a file get the read and write checks on every path', async () => {
  const cred = path.join(HOME, '.aws', 'credentials');
  assert.equal((await run(pre('FutureViewer', { file_path: cred }))).output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await run(pre('FutureEditor', { edits: [{ file_path: '/work/proj/ok.js' }, { file_path: path.join(HOME, '.zcode', 'cli', 'config.json') }] }))).output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await run(pre('Mystery', { q: 1 }))).output, null);
});

test('an MCP call is checked before it runs: secret placeholders and credential paths are blocked', async () => {
  assert.equal((await run(pre('mcp__web__post', { auth: '__ZN_TOKEN__' }))).output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await run(pre('mcp__fs__read', { path: path.join(HOME, '.ssh', 'id_rsa') }))).output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await run(pre('mcp__web__post', { auth: 'AKIAIOSFODNN7EXAMPLE' }))).output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await run(pre('mcp__web__post', { q: 'hello' }))).output, null);
});

test('the secrets MCP server is zn\'s own only when the user config registers zn\'s server under that name', (t) => {
  const home = tempDir(t, 'zn-zc-ours-');
  const real = process.env.HOME;
  const os = require('os');
  const orig = os.homedir;
  os.homedir = () => home;
  t.after(() => { os.homedir = orig; process.env.HOME = real; });
  const ev = () => zc.normalize({ ...pre('mcp__secrets__secrets_list', {}) }).mcp;
  assert.equal(ev().ours, undefined, 'no config: not ours');
  write(home, { mcp: { servers: { secrets: { type: 'stdio', command: 'someone-else', args: ['x'] } } } });
  assert.equal(ev().ours, undefined);
  write(home, { mcp: { servers: { secrets: { type: 'stdio', command: 'zn', args: ['secrets-mcp', '--agent', 'zcode'] } } } });
  assert.equal(ev().ours, 'secrets');
  assert.equal(zc.normalize(pre('mcp__secrets__x__secrets_list', {})).mcp.ours, undefined, 'a server named secrets__x is not the zn one');
  write(home, { mcp: { servers: { secrets: { type: 'stdio', command: 'zn', args: ['secrets-mcp'], enabled: false } } } });
  assert.equal(ev().ours, undefined, 'a disabled server is not what ran');
  assert.equal(zc.normalize(pre('mcp__other__secrets_list', {})).mcp.ours, undefined);
});

test('PostToolUse: a notice for a secret in the output, nothing for clean output; the output is never rewritten', async () => {
  const mk = (resp) => ({ hook_event_name: 'PostToolUse', session_id: 's', cwd: '/work/proj', tool_name: 'Bash', tool_input: { command: 'env' }, tool_use_id: 'u', tool_response: resp });
  const hit = await run(mk({ stdout: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE' }));
  validZCodeOutput(hit.output, 'PostToolUse');
  assert.deepEqual(Object.keys(hit.output.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
  assert.match(hit.output.hookSpecificOutput.additionalContext, /1 secret value/);
  assert.equal((await run(mk({ stdout: 'nothing secret in here at all' }))).output, null);
  assert.equal((await run({ ...mk('x'), tool_name: 'Write' })).output, null, 'tools whose output is not checked');
});

test('an unreadable hook input is refused with exit code 2 and the reason on stderr (the documented block)', (t) => {
  const home = tempDir(t, 'zn-zc-run-');
  for (const input of ['', 'not json', '[1]']) {
    const r = spawnSync(process.execPath, [RUNNER, 'zcode'], { input, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off' } });
    assert.equal(r.status, 2, JSON.stringify(input));
    assert.match(r.stderr, /could not read this action/);
    assert.match(r.stderr, /hooks install zcode/);
  }
});

/* --------------------------- hook failure (watchdog) -------------------------- */

function spawnHook(t, payload, fault) {
  const home = tempDir(t, 'zn-zc-fc-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off', ZN_TEST_HOOK_FAULTS: '1', ...fault };
  const started = Date.now();
  const r = spawnSync(process.execPath, [RUNNER, 'zcode'], { input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 20000 });
  return { ...r, ms: Date.now() - started };
}

test('the watchdog answers before ZCode\'s own timeout', () => {
  assert.ok(zc.HOOK_TIMEOUT_S >= 10);
  assert.equal(zc.HOOK_TIMEOUT_MS, zc.HOOK_TIMEOUT_S * 1000);
  assert.ok(zc.HOOK_TIMEOUT_MS < 60000, 'below ZCode\'s default timeout of 60000 ms');
  assert.ok(runner.postDeadlineMs('zcode') < zc.HOOK_TIMEOUT_MS);
});

for (const [event, payload, check] of [
  ['PreToolUse', pre('Bash', { command: 'echo hi' }), (o) => assert.equal(o.hookSpecificOutput.permissionDecision, 'deny')],
  ['PermissionRequest', { ...pre('Bash', { command: 'echo hi' }), hook_event_name: 'PermissionRequest' }, (o) => assert.equal(o.hookSpecificOutput.decision.behavior, 'deny')],
  ['UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/w', prompt: 'hello' }, (o) => assert.equal(o.continue, false)],
]) {
  test('zcode ' + event + ': a hung or crashing check is answered with deny and exit 2 (ZCode would otherwise run the call)', (t) => {
    for (const fault of [{ ZN_TEST_HOOK_FAULT: 'hang', ZN_TEST_HOOK_HANG_MS: '30000', ZN_TEST_HOOK_DEADLINE_MS: '800' }, { ZN_TEST_HOOK_FAULT: 'throw' }]) {
      const r = spawnHook(t, payload, fault);
      assert.equal(r.status, 2, r.stderr);
      const out = JSON.parse(r.stdout);
      validZCodeOutput(out, event);
      check(out);
      assert.ok(r.ms < 10000, 'answered in ' + r.ms + ' ms');
    }
  });
}

/* --------------------------- install / uninstall -------------------------- */

test('install (user) writes the four events with process hooks, turns hooks on, registers the MCP server and backs up', (t) => {
  const home = tempDir(t, 'zn-zc-home-');
  const mine = { ui: { locale: 'en' }, permission: { disallowedTools: ['WebSearch'] }, hooks: { enabled: false, timeoutMs: 20000, events: {
    PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'process', command: 'node', args: ['/mine/check.mjs'], timeoutMs: 5000 }] }],
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: './hello.sh' }] }],
  } }, mcp: { servers: { other: { type: 'stdio', command: 'x', args: [] } } } };
  write(home, mine);
  const rep = zc.install({ home, nodePath: '/usr/bin/node' });
  assert.equal(rep.settings, cliFile(home));
  assert.ok(rep.backup && fs.existsSync(rep.backup));
  assert.deepEqual(JSON.parse(fs.readFileSync(rep.backup, 'utf8')), mine);
  const data = readCfg(home);
  assert.deepEqual(data.ui, mine.ui);
  assert.deepEqual(data.permission, mine.permission);
  assert.equal(data.hooks.enabled, true);
  assert.equal(data.hooks.timeoutMs, 20000);
  assert.deepEqual(data.hooks.events.SessionStart, mine.hooks.events.SessionStart);
  assert.deepEqual(data.hooks.events.PreToolUse[0], mine.hooks.events.PreToolUse[0], 'the user\'s own hook stays first');
  assert.deepEqual(Object.keys(data.hooks.events).sort(), ['PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionStart', 'UserPromptSubmit']);
  const file = launcher.launcherFile('zcode', { home, env: process.env });
  for (const ev of zc.EVENTS) {
    const g = data.hooks.events[ev].find((x) => x.hooks.some((h) => cfg.isOurs(zc.commandText(h), 'zcode')));
    assert.ok(g, ev);
    // Only the keys ZCode's strict schema knows: a stray key would make it drop the whole file.
    assert.ok(Object.keys(g).every((k) => ['matcher', 'hooks'].includes(k)), ev);
    assert.equal(g.hooks.length, 1);
    if (WIN) {
      // Windows: the same three steps as an inline PowerShell script, no launcher file.
      const sq = require('../lib/shell-quote');
      assert.deepEqual({ ...g.hooks[0], args: g.hooks[0].args.slice(0, 3) }, { type: 'process', command: sq.powershellExe(), args: ['-NoProfile', '-NonInteractive', '-EncodedCommand'], timeoutMs: zc.HOOK_TIMEOUT_MS, statusMessage: zc.HOOK_STATUS });
      assert.match(sq.windowsCommandScript(zc.commandText(g.hooks[0])), new RegExp(' # zn hook zcode$'));
    } else {
      assert.deepEqual(g.hooks[0], { type: 'process', command: file, args: [ev], timeoutMs: zc.HOOK_TIMEOUT_MS, statusMessage: zc.HOOK_STATUS });
    }
  }
  assert.equal(data.hooks.events.PreToolUse[1].matcher, '*');
  assert.equal(data.hooks.events.UserPromptSubmit[0].matcher, undefined);
  assert.deepEqual(data.mcp.servers.other, mine.mcp.servers.other);
  const s = data.mcp.servers.secrets;
  assert.equal(s.type, 'stdio');
  assert.equal(s.command, '/usr/bin/node');
  assert.deepEqual(s.args.slice(1), ['secrets-mcp', '--agent', 'zcode']);
  assert.equal(rep.mcp, cliFile(home));
  if (WIN) assert.equal(fs.existsSync(file), false, 'Windows has no sh launcher');
  else assert.ok(fs.statSync(file).mode & 0o100, 'the launcher is executable (ZCode starts a process hook directly, with no shell)');
});

test('install is idempotent and uninstall removes only zn: the user\'s hooks, settings and MCP servers stay', (t) => {
  const home = tempDir(t, 'zn-zc-idem-');
  const mine = { ui: { locale: 'en' }, hooks: { enabled: true, events: {
    PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'process', command: 'node', args: ['/mine/check.mjs'], timeoutMs: 5000 }] }],
    Stop: [{ hooks: [{ type: 'command', command: './done.sh' }] }],
  } }, mcp: { servers: { other: { type: 'stdio', command: 'x' } } } };
  write(home, mine);
  zc.install({ home, nodePath: '/usr/bin/node' });
  const once = readCfg(home);
  zc.install({ home, nodePath: '/usr/bin/node' });
  assert.deepEqual(readCfg(home), once, 'a second install changes nothing');
  const rep = zc.uninstall({ home });
  assert.equal(rep.removed, 1);
  assert.ok(rep.backup);
  assert.deepEqual(readCfg(home), mine);
  assert.equal(zc.uninstall({ home }).removed, 0);
  // Windows has no sh launcher (the hook is an inline PowerShell script): nothing to share or remove.
  assert.equal(fs.existsSync(launcher.launcherFile('zcode', { home, env: process.env })), !WIN, 'the launcher is shared: only the machine-wide uninstall removes it');
  zc.install({ home, nodePath: '/usr/bin/node' });
  zc.uninstall({ home, removeLauncher: true });
  assert.equal(fs.existsSync(launcher.launcherFile('zcode', { home, env: process.env })), false);
});

test('uninstall from a config zn created leaves no hooks or mcp keys behind; a hook of the user in the same group stays', (t) => {
  const home = tempDir(t, 'zn-zc-clean-');
  write(home, { ui: { locale: 'es' } });
  zc.install({ home, nodePath: '/usr/bin/node' });
  zc.uninstall({ home });
  assert.deepEqual(readCfg(home), { ui: { locale: 'es' } });

  const theirs = { type: 'process', command: 'node', args: ['/theirs.mjs'] };
  const old = { type: 'command', command: '"/old/node" "/old/zn-gate/lib/hooks/runner.js" zcode' };
  write(home, { hooks: { enabled: true, events: { PreToolUse: [{ matcher: '*', hooks: [theirs, old] }] } } });
  zc.install({ home, nodePath: '/usr/bin/node', mcp: false });
  assert.deepEqual(readCfg(home).hooks.events.PreToolUse[0].hooks, [theirs], 'an older zn hook is replaced');
  assert.equal(readCfg(home).mcp, undefined, '--no-mcp registers nothing');
  zc.uninstall({ home });
  assert.deepEqual(readCfg(home).hooks, { enabled: true, events: { PreToolUse: [{ matcher: '*', hooks: [theirs] }] } });
});

test('an MCP server called "secrets" that is not zn\'s is left alone, on install and on uninstall', (t) => {
  const home = tempDir(t, 'zn-zc-mcp-');
  const theirs = { type: 'stdio', command: 'their-secrets', args: ['serve'] };
  write(home, { mcp: { servers: { secrets: theirs } } });
  const rep = zc.install({ home, nodePath: '/usr/bin/node' });
  assert.deepEqual(readCfg(home).mcp.servers.secrets, theirs);
  assert.ok(rep.warnings.some((w) => /already exists/.test(w)));
  assert.equal(rep.mcp, undefined);
  const un = zc.uninstall({ home });
  assert.deepEqual(readCfg(home).mcp.servers.secrets, theirs);
  assert.ok(un.warnings.some((w) => /not zn's/.test(w)));
});

test('install and uninstall refuse a config of the wrong shape and leave it alone', (t) => {
  const home = tempDir(t, 'zn-zc-bad-');
  for (const text of ['[1]', '{"hooks": []}', '{"hooks": {"events": []}}', '{"hooks": {"events": {"PreToolUse": {}}}}', '{"mcp": []}', '{"mcp": {"servers": 3}}', '{ not json']) {
    write(home, text);
    assert.throws(() => zc.install({ home }), undefined, text);
    assert.equal(fs.readFileSync(cliFile(home), 'utf8'), text, text);
  }
});

test('there is no project install: ZCode ignores project hooks', (t) => {
  const dir = tempDir(t, 'zn-zc-proj-');
  assert.throws(() => zc.install({ scope: 'project', projectDir: dir }), /ignores the hooks of a project/);
  assert.equal(fs.existsSync(path.join(dir, '.zcode')), false);
  const un = zc.uninstall({ scope: 'project', projectDir: dir, home: dir });
  assert.equal(un.removed, 0);
  assert.ok(un.warnings.length);
});

test('install on Windows writes a powershell.exe process hook that exits 2 itself; a command given by the caller is a shell command', (t) => {
  const home = tempDir(t, 'zn-zc-win-');
  zc.install({ home, platform: 'win32', nodePath: 'C:/Program Files/nodejs/node.exe', runnerPath: 'C:/zn/zn-gate/lib/hooks/runner.js' });
  const g = readCfg(home).hooks.events.PreToolUse.find((x) => x.hooks.some((h) => h.command === 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'));
  const h = g.hooks[0];
  assert.equal(h.type, 'process');
  assert.deepEqual(h.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = require('../lib/shell-quote').windowsCommandScript(zc.commandText(h));
  assert.match(script, /\$rc = zr .*runner\.js" zcode'; if \(\(\$rc -eq 0 -and \(zk\)\) -or \$rc -eq 2\) \{ zx \$rc \}/);
  assert.match(script, /Console\]::Error\.WriteLine\('zn: its hook cannot start.*exit 2 # zn hook zcode$/);
  assert.ok(cfg.isOurs(zc.commandText(h), 'zcode'));
  // PostToolUse only warns when the Node.js is gone (exit 0 with a systemMessage).
  const post = readCfg(home).hooks.events.PostToolUse[0].hooks[0];
  assert.match(require('../lib/shell-quote').windowsCommandScript(zc.commandText(post)), /systemMessage.*exit 0 # zn hook zcode$/);
  zc.uninstall({ home });
  assert.equal(fs.existsSync(cliFile(home)) ? readCfg(home).hooks : undefined, undefined);

  zc.install({ home, command: 'node /x/zn-gate/lib/hooks/runner.js zcode', mcp: false });
  assert.deepEqual(readCfg(home).hooks.events.UserPromptSubmit[0].hooks[0].type, 'command');
  assert.equal(zc.uninstall({ home }).removed, 1);
});

test('install warnings: no output rewriting, user config only, fail-open on crash', (t) => {
  const home = tempDir(t, 'zn-zc-warn-');
  const all = zc.install({ home, nodePath: '/usr/bin/node' }).warnings.join('\n');
  assert.doesNotMatch(all, /experimental/);
  assert.match(all, /cannot rewrite what a tool returns/);
  assert.match(all, /hooks of a project are ignored/);
  assert.match(all, /zn turned it on/);
  assert.match(all, /only exit code 2 blocks/);
  assert.match(all, /new ZCode session/);
  assert.doesNotMatch(zc.install({ home, nodePath: '/usr/bin/node' }).warnings.join('\n'), /zn turned it on/);
  write(home, { features: { mcp: false } });
  assert.match(zc.install({ home, nodePath: '/usr/bin/node' }).warnings.join('\n'), /features\.mcp/);
});

/* -------------------------------- launcher -------------------------------- */

test('launcher: with the Node.js gone the events that can deny exit 2 with the repair step; PostToolUse only warns', (t) => {
  const home = tempDir(t, 'zn-zc-launch-');
  zc.install({ home, nodePath: '/nonexistent/node-gone/bin/node', runnerPath: RUNNER });
  const data = readCfg(home);
  const bin = tempDir(t, 'zn-zc-bin-');
  for (const ev of ['PreToolUse', 'PermissionRequest', 'UserPromptSubmit']) {
    const h = data.hooks.events[ev][0].hooks[0];
    // ZCode starts a "process" hook with the file and its arguments, no shell.
    const r = spawnSync(h.command, h.args, { input: '{}', encoding: 'utf8', env: { PATH: bin, HOME: '/nonexistent' } });
    assert.equal(r.status, 2, ev);
    assert.match(r.stderr, /zn hooks install zcode/);
    assert.equal(r.stdout, '');
  }
  const post = data.hooks.events.PostToolUse[0].hooks[0];
  const r = spawnSync(post.command, post.args, { input: '{}', encoding: 'utf8', env: { PATH: bin, HOME: '/nonexistent' } });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /NOT protecting this session.*zn hooks install zcode/);
});

test('launcher: with the recorded Node.js it runs the real hook, and a deny comes out as the PreToolUse JSON', (t) => {
  const home = tempDir(t, 'zn-zc-real-');
  zc.install({ home, nodePath: process.execPath, runnerPath: RUNNER });
  const h = readCfg(home).hooks.events.PreToolUse[0].hooks[0];
  const dir = tempDir(t, 'zn-zc-proj-');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=sk-test-EXAMPLE0000000000000000\n');
  const ev = pre('Read', { file_path: path.join(dir, '.env') }, { cwd: dir });
  const r = spawnSync(h.command, h.args, { input: JSON.stringify(ev), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ZN_STATS: 'off' } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  validZCodeOutput(out, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

/* ------------------------------ zn-gate check ----------------------------- */

test('zn-gate check reads the ZCode install state (absent, set up) and runs the installed hook', async (t) => {
  const check = require('../lib/check');
  const home = tempDir(t, 'zn-zc-check-');
  const cwd = tempDir(t, 'zn-zc-check-cwd-');
  const env = { ...process.env, HOME: home };
  const find = async (live) => (await check.check({ home, cwd, env, live })).results.find((r) => r.id === 'zcode');
  assert.equal((await find(false)).state, 'not-set-up');
  zc.install({ home, nodePath: process.execPath });
  const setup = await find(false);
  assert.notEqual(setup.state, 'not-set-up');
  const live = await find(true);
  assert.equal(live.state, 'protected', live.problem);
  assert.equal(live.verified, true);
});

test('zn-gate check warns when hooks.enabled is false or not set, or when an entry of zn\'s is switched off', async (t) => {
  const check = require('../lib/check');
  const home = tempDir(t, 'zn-zc-pol-');
  const cwd = tempDir(t, 'zn-zc-pol-cwd-');
  const env = { ...process.env, HOME: home };
  zc.install({ home, nodePath: process.execPath });
  const find = async () => (await check.check({ home, cwd, env, live: true })).results.find((r) => r.id === 'zcode');
  assert.equal((await find()).state, 'protected');

  const good = readCfg(home);
  write(home, { ...good, hooks: { ...good.hooks, enabled: false } });
  let r = await find();
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /"hooks\.enabled" is false/);
  assert.match(r.fix, /zn hooks install zcode/);

  const noFlag = { ...good, hooks: { ...good.hooks } };
  delete noFlag.hooks.enabled;
  write(home, noFlag);
  assert.match((await find()).problem, /"hooks\.enabled" is not set/);

  const off = JSON.parse(JSON.stringify(good));
  off.hooks.events.PermissionRequest[0].hooks[0].enabled = false;
  write(home, off);
  r = await find();
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /PermissionRequest hook has "enabled": false/);

  const bg = JSON.parse(JSON.stringify(good));
  bg.hooks.events.PreToolUse[0].hooks[0].async = true;
  write(home, bg);
  assert.match((await find()).problem, /background/);

  write(home, { ...good, features: { mcp: false } });
  r = await find();
  assert.equal(r.state, 'protected');
  assert.ok(r.notes.some((n) => /features\.mcp/.test(n)));
});

test('zn-gate check: a Node.js that is gone is reported with the repair step', async (t) => {
  const check = require('../lib/check');
  const home = tempDir(t, 'zn-zc-gone-');
  const cwd = tempDir(t, 'zn-zc-gone-cwd-');
  zc.install({ home, nodePath: '/nonexistent/node-gone/bin/node', runnerPath: RUNNER });
  const bin = tempDir(t, 'zn-zc-gone-bin-');
  const r = (await check.check({ home, cwd, env: { HOME: home, PATH: bin }, live: true })).results.find((x) => x.id === 'zcode');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /its hook cannot start/);
  assert.match(r.fix, /zn hooks install zcode/);
});

test('configWarnings: a missing or unreadable file says nothing wrong', (t) => {
  const home = tempDir(t, 'zn-zc-cw-');
  assert.deepEqual(zc.configWarnings({ home }).problems, []);
  assert.deepEqual(zc.configWarnings({ home }).notes, []);
  write(home, '{ broken');
  assert.deepEqual(zc.configWarnings({ home }).problems, []);
  assert.equal(zc.configWarnings({ home }).notes.length, 1);
});

test('detect: the zcode program on PATH or a ~/.zcode folder', (t) => {
  const home = tempDir(t, 'zn-zc-det-');
  const bin = tempDir(t, 'zn-zc-det-bin-');
  assert.equal(zc.detect({ home, env: { PATH: bin } }), false);
  fs.mkdirSync(path.join(home, '.zcode'));
  assert.equal(zc.detect({ home, env: { PATH: bin } }), true);
});

test('the hook policy knows the install hint for zcode', () => {
  assert.match(policy.bashDenial('zn hooks install zcode'), /hooks install zcode`/);
});

/* --------------------- answer shapes from the official ZCode hooks documentation --------------------- */

test('respond() answers a denied prompt with continue:false and no hookSpecificOutput', () => {
  const ev = zc.normalize({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/w', prompt: 'x' });
  const out = zc.respond({ decision: 'deny', message: 'blocked', event: ev });
  assert.deepEqual(out, { continue: false, reason: 'blocked' });
});

test('PermissionRequest only ever gets deny, whatever the internal decision (allow would skip the approval screen)', () => {
  const ev = zc.normalize({ hook_event_name: 'PermissionRequest', session_id: 's', cwd: '/w', tool_name: 'Bash', tool_input: { command: 'ls' } });
  for (const d of [{ decision: 'allow' }, { decision: 'ask', message: 'q' }, { decision: 'allow', updatedInput: { command: 'x' }, kind: 'wrap' }, { decision: 'deny', message: 'no' }]) {
    const out = zc.respond({ ...d, event: ev });
    if (out === null) continue;
    assert.equal(out.hookSpecificOutput.decision.behavior, 'deny', JSON.stringify(d));
  }
  assert.equal(zc.respond({ decision: 'allow', event: ev }), null);
});

test('the camelCase fields alone are read like the snake_case ones, and the tool names map to the checks', () => {
  const camel = { hookEventName: 'PreToolUse', sessionId: 's', cwd: '/w', toolName: 'Read', toolInput: { file_path: '/w/a.txt' }, toolCallId: 'c', riskLevel: 'low', sideEffectScope: 'none', mode: 'yolo', transcriptPath: '/t' };
  const ev = zc.normalize(camel);
  assert.equal(ev.event, 'pre_tool');
  assert.equal(ev.tool, 'read');
  assert.deepEqual(ev.input.paths, ['/w/a.txt']);
  for (const [name, input, tool] of [['Bash', { command: 'ls', description: 'd' }, 'bash'], ['Write', { file_path: '/w/a', content: 'x' }, 'write'], ['Edit', { file_path: '/w/a', old_string: 'a', new_string: 'b', replace_all: false }, 'edit'],
    ['WebFetch', { url: 'https://example.com', prompt: 'p' }, 'webfetch'], ['mcp__zn_fake__echo', { text: 'hi' }, 'mcp']]) {
    const e = zc.normalize({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, session_id: 's', cwd: '/w' });
    assert.equal(e.tool, tool, name);
    assert.notEqual(e.tool, 'unreadable', name);
  }
  assert.equal(zc.normalize({ hook_event_name: 'PreToolUse', tool_name: 'mcp__zn_fake__echo', tool_input: { text: 'hi' }, cwd: '/w' }).mcp.server, 'zn_fake');
});

test('the agent is the one the launcher names; the CLAUDE_* variables ZCode sets change nothing', (t) => {
  const home = tempDir(t, 'zn-zc-env-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off', CLAUDE_PROJECT_DIR: '/w', CLAUDE_SESSION_ID: 's', CLAUDE_CODE_SESSION_ID: 's', ZCODE_PROJECT_DIR: '/w', ZCODE_SESSION_ID: 's' };
  delete env.CLAUDECODE;
  const payload = { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/w', tool_name: 'Read', tool_input: { file_path: path.join(home, '.aws', 'credentials') }, tool_use_id: 'u' };
  const r = spawnSync(process.execPath, [RUNNER, 'zcode'], { input: JSON.stringify(payload), encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  validZCodeOutput(out, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('several hooks at once in one home all answer (no lock that deadlocks)', async (t) => {
  const home = tempDir(t, 'zn-zc-par-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off' };
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/w', tool_name: 'Read', tool_input: { file_path: path.join(home, '.aws', 'credentials') }, tool_use_id: 'u' });
  const { spawn } = require('child_process');
  const one = () => new Promise((resolve) => {
    const c = spawn(process.execPath, [RUNNER, 'zcode'], { env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { c.kill('SIGKILL'); resolve({ hung: true }); }, 15000);
    c.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    c.stdin.end(payload);
  });
  const all = await Promise.all(Array.from({ length: 6 }, one));
  for (const r of all) {
    assert.ok(!r.hung, 'a hook hung');
    assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('the hooks.enabled warning says the hooks of that file do not run (plugin hooks do), not all hooks', (t) => {
  const home = tempDir(t, 'zn-zc-warn-');
  write(home, { hooks: { enabled: false } });
  const w = zc.configWarnings({ home });
  assert.match(w.problems[0], /"hooks\.enabled" is false/);
  assert.match(w.problems[0], /none of the hooks in that file/);
});

test('uninstall gives "hooks.enabled" back the value it had before zn turned it on (false or not set), the file byte for byte', (t) => {
  const hook = { type: 'process', command: 'node', args: ['/mine/check.mjs'] };
  const cases = {
    'enabled false with hooks of the user': { ui: { locale: 'en' }, hooks: { enabled: false, events: { Stop: [{ hooks: [hook] }] } } },
    'enabled not set with hooks of the user': { hooks: { events: { Stop: [{ hooks: [hook] }] } }, ui: { locale: 'en' } },
    'enabled false and nothing else': { hooks: { enabled: false }, ui: { locale: 'en' } },
    'enabled true already': { hooks: { enabled: true, events: { Stop: [{ hooks: [hook] }] } } },
  };
  for (const [name, mine] of Object.entries(cases)) {
    const home = tempDir(t, 'zn-zc-home-');
    write(home, mine);
    const text = fs.readFileSync(cliFile(home), 'utf8');
    const rep = zc.install({ home, nodePath: '/usr/bin/node' });
    assert.equal(readCfg(home).hooks.enabled, true, name);
    const userHooks = mine.hooks.events !== undefined && mine.hooks.enabled !== true;
    assert.equal(rep.warnings.some((w) => /these hooks of yours did not run until now/.test(w) && w.includes('Stop: ')), userHooks, name);
    zc.uninstall({ home });
    assert.equal(fs.readFileSync(cliFile(home), 'utf8'), text, name);
    assert.ok(!fs.existsSync(path.join(home, '.zn', 'state', 'zcode-hooks-enabled.json')), name);
  }
});

test('uninstall keeps what the user set after zn turned hooks on, and a re-install keeps the first previous value', (t) => {
  const home = tempDir(t, 'zn-zc-home-');
  write(home, { hooks: { enabled: false } });
  zc.install({ home, nodePath: '/usr/bin/node' });
  zc.install({ home, nodePath: '/usr/bin/node' });
  zc.uninstall({ home });
  assert.deepEqual(readCfg(home), { hooks: { enabled: false } });
  // The user flips the switch off themselves after the install: uninstall does not turn anything on or off.
  const home2 = tempDir(t, 'zn-zc-home-');
  write(home2, { hooks: { events: { Stop: [{ hooks: [{ type: 'process', command: 'x' }] }] } } });
  zc.install({ home: home2, nodePath: '/usr/bin/node' });
  const d = readCfg(home2);
  d.hooks.enabled = false;
  write(home2, d);
  zc.uninstall({ home: home2 });
  assert.equal(readCfg(home2).hooks.enabled, false);
});

// Windows: the test makes the state folder unwritable with chmod 0555, which a Windows folder does not honor (no mode bits).
test('uninstall restores "hooks.enabled" only while a zn hook is still there, and reports a state file it cannot delete', { skip: !posix || (process.getuid && process.getuid() === 0) }, (t) => {
  const home = tempDir(t, 'zn-zc-home-');
  write(home, { hooks: { enabled: false } });
  zc.install({ home, nodePath: '/usr/bin/node' });
  const dir = path.dirname(path.join(home, '.zn', 'state', 'zcode-hooks-enabled.json'));
  fs.chmodSync(dir, 0o555);
  let rep;
  try { rep = zc.uninstall({ home }); } finally { fs.chmodSync(dir, 0o755); }
  assert.equal(rep.removed, 1);
  assert.equal(rep.stateNotCleared, path.join(dir, 'zcode-hooks-enabled.json'));
  assert.ok(rep.warnings.some((w) => /could not delete .*zcode-hooks-enabled\.json/.test(w)));
  assert.deepEqual(readCfg(home), { hooks: { enabled: false } });
  assert.ok(fs.existsSync(path.join(dir, 'zcode-hooks-enabled.json')));
  // The user turns hooks on again (no zn hook in the file): a second uninstall must leave the switch on.
  write(home, { hooks: { enabled: true, events: { Stop: [{ hooks: [{ type: 'process', command: 'x' }] }] } } });
  const again = zc.uninstall({ home });
  assert.equal(again.removed, 0);
  assert.equal(readCfg(home).hooks.enabled, true);
  assert.ok(!fs.existsSync(path.join(dir, 'zcode-hooks-enabled.json')), 'the leftover is cleared once no zn hook needs it');
  assert.equal(again.stateNotCleared, undefined);
});

test('install and uninstall on a missing config leave an empty one', (t) => {
  const home = tempDir(t, 'zn-zc-home-');
  zc.install({ home, nodePath: '/usr/bin/node' });
  zc.uninstall({ home });
  assert.deepEqual(readCfg(home), {});
});

/* ------------------- atomic install / uninstall, start-up deadline ------------------- */

const stateFile = (home) => path.join(home, '.zn', 'state', 'zcode-hooks-enabled.json');

test('install that cannot save its state leaves config.json byte for byte as it was, and a later uninstall changes nothing', (t) => {
  const hook = { type: 'process', command: 'node', args: ['/mine/check.mjs'] };
  const home = tempDir(t, 'zn-zc-atomic-state-');
  write(home, { hooks: { enabled: false, events: { Stop: [{ hooks: [hook] }] } } });
  const text = fs.readFileSync(cliFile(home), 'utf8');
  // A plain file where the state folder must be: the state cannot be written (the same outcome as an unwritable folder).
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zn', 'state'), 'not a folder');
  assert.throws(() => zc.install({ home, nodePath: '/usr/bin/node' }));
  assert.equal(fs.readFileSync(cliFile(home), 'utf8'), text, 'the user\'s hooks were not switched on');
  assert.equal(zc.uninstall({ home }).removed, 0);
  assert.equal(fs.readFileSync(cliFile(home), 'utf8'), text);
  assert.deepEqual(fs.readdirSync(path.dirname(cliFile(home))).filter((f) => f.endsWith('.zn-tmp')), []);
});

test('install whose config write fails puts the state back (none, or the one that was there) and leaves config.json valid and unchanged', (t) => {
  const home = tempDir(t, 'zn-zc-atomic-cfg-');
  write(home, { hooks: { enabled: false } });
  const text = fs.readFileSync(cliFile(home), 'utf8');
  const realWrite = cfg.writeJson;
  cfg.writeJson = () => { throw new Error('disk full'); };
  try {
    assert.throws(() => zc.install({ home, nodePath: '/usr/bin/node' }), /disk full/);
    assert.equal(fs.existsSync(stateFile(home)), false, 'no state without a config that needs it');
    fs.mkdirSync(path.dirname(stateFile(home)), { recursive: true });
    const old = JSON.stringify({ file: cliFile(home), previous: 'absent' }) + '\n';
    fs.writeFileSync(stateFile(home), old);
    assert.throws(() => zc.install({ home, nodePath: '/usr/bin/node' }), /disk full/);
    assert.equal(fs.readFileSync(stateFile(home), 'utf8'), old, 'the state that was there stays');
  } finally {
    cfg.writeJson = realWrite;
  }
  assert.equal(fs.readFileSync(cliFile(home), 'utf8'), text);
  JSON.parse(fs.readFileSync(cliFile(home), 'utf8'));
});

test('uninstall whose config write fails keeps the state; the retry gives hooks.enabled its old value back', (t) => {
  const hook = { type: 'process', command: 'node', args: ['/mine/check.mjs'] };
  const home = tempDir(t, 'zn-zc-atomic-un-');
  write(home, { hooks: { enabled: false, events: { Stop: [{ hooks: [hook] }] } } });
  const original = fs.readFileSync(cliFile(home), 'utf8');
  zc.install({ home, nodePath: '/usr/bin/node' });
  const installed = fs.readFileSync(cliFile(home), 'utf8');
  const realWrite = cfg.writeJson;
  cfg.writeJson = () => { throw new Error('read-only file system'); };
  try {
    assert.throws(() => zc.uninstall({ home }), /read-only/);
  } finally {
    cfg.writeJson = realWrite;
  }
  assert.equal(fs.readFileSync(cliFile(home), 'utf8'), installed, 'config.json is as the install left it');
  assert.ok(fs.existsSync(stateFile(home)), 'the state is kept until the config is restored');
  zc.uninstall({ home });
  assert.equal(fs.readFileSync(cliFile(home), 'utf8'), original);
  assert.equal(fs.existsSync(stateFile(home)), false);
});

test('a state left by a crash before the config was written does not leak into the next install', (t) => {
  const home = tempDir(t, 'zn-zc-atomic-stale-');
  write(home, { hooks: { enabled: false } });
  fs.mkdirSync(path.dirname(stateFile(home)), { recursive: true });
  fs.writeFileSync(stateFile(home), JSON.stringify({ file: cliFile(home), previous: 'absent' }) + '\n');
  const text = fs.readFileSync(cliFile(home), 'utf8');
  zc.install({ home, nodePath: '/usr/bin/node' });
  zc.uninstall({ home });
  assert.equal(fs.readFileSync(cliFile(home), 'utf8'), text, 'enabled goes back to false, not to "not set"');
});

function fakeNode(t, body) {
  const dir = tempDir(t, 'zn-zc-fakenode-');
  const f = path.join(dir, 'node');
  fs.writeFileSync(f, '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
  return f;
}

test('launcher deadline: a hook stuck on start-up is answered before ZCode would time out (exit 2 / deny), with no wait for the stuck process', { skip: needSh }, (t) => {
  const home = tempDir(t, 'zn-zc-deadline-');
  const slow = fakeNode(t, 'cat >/dev/null; exec sleep 60');
  const file = launcher.writeLauncher('zcode', slow, RUNNER, { home, env: process.env, deadlineS: 1 });
  const env = { PATH: process.env.PATH, HOME: home };
  for (const ev of ['PreToolUse', 'PermissionRequest', 'UserPromptSubmit']) {
    const t0 = Date.now();
    const r = spawnLauncher(file, [ev], { input: '{}', encoding: 'utf8', env, timeout: 20000 });
    assert.equal(r.status, 2, ev + ' ' + r.stderr);
    assert.match(r.stderr, /its hook failed, so this was blocked/);
    assert.ok(Date.now() - t0 < 8000, 'answered by the deadline, not by the 60 s sleep');
  }
  const post = spawnLauncher(file, ['PostToolUse'], { input: '{}', encoding: 'utf8', env, timeout: 20000 });
  assert.equal(post.status, 0);
  assert.match(JSON.parse(post.stdout).systemMessage, /NOT protecting this session/);
});

test('launcher deadline: a hook that answers in time gets the input and its exit code and output pass through; nothing lingers', { skip: needSh }, (t) => {
  const home = tempDir(t, 'zn-zc-deadline-ok-');
  const echo = fakeNode(t, 'cat; printf ok > "$ZN_HOOK_ACK"; exit 0');
  const file = launcher.writeLauncher('zcode', echo, RUNNER, { home, env: process.env, deadlineS: 30 });
  const t0 = Date.now();
  const r = spawnLauncher(file, ['PreToolUse'], { input: '{"a":1}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home }, timeout: 20000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{"a":1}');
  assert.ok(Date.now() - t0 < 8000, 'returns at once, it does not wait for the 30 s timer');
  const two = fakeNode(t, 'cat >/dev/null; echo refused >&2; exit 2');
  const f2 = launcher.writeLauncher('zcode', two, RUNNER, { home: tempDir(t, 'zn-zc-deadline-2-'), env: process.env, deadlineS: 30 });
  const r2 = spawnLauncher(f2, ['PreToolUse'], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home }, timeout: 20000 });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /refused/);
});

// Windows: install writes no sh launcher (see 'Windows launcher: install gives ZCode the deadline' below for its PowerShell form).
test('install writes the zcode launcher with a deadline 2 s under the hook timeout; other agents\' launchers have none', { skip: !posix }, (t) => {
  const home = tempDir(t, 'zn-zc-deadline-text-');
  zc.install({ home, nodePath: '/usr/bin/node' });
  const text = fs.readFileSync(launcher.launcherFile('zcode', { home, env: process.env }), 'utf8');
  assert.equal(zc.LAUNCHER_DEADLINE_S, zc.HOOK_TIMEOUT_S - 2);
  assert.match(text, new RegExp('sleep ' + zc.LAUNCHER_DEADLINE_S + ' &'));
  assert.doesNotMatch(launcher.unixScript('codex', '/usr/bin/node', RUNNER), /zn_run/);
});

test('Windows launcher: ZCode only, the hook runs as a child with a deadline, a timeout kills the tree and takes the block path', () => {
  const N = 'C:/Program Files/nodejs/node.exe';
  const R = 'C:/zn/zn-gate/lib/hooks/runner.js';
  const zcodeScript = (event) => launcher.windowsScript('zcode', event, N, R, { deadlineS: zc.LAUNCHER_DEADLINE_S });
  const pre = zcodeScript('PreToolUse');
  assert.match(pre, /function zr\(\$f, \$a\)/);
  assert.ok(pre.includes('.Wait(' + zc.LAUNCHER_DEADLINE_S * 1000 + ')'));
  assert.match(pre, /RedirectStandardInput = \$true/);
  assert.match(pre, /OpenStandardInput\(\)\.CopyToAsync/);
  assert.ok(pre.includes('try { & "$env:SystemRoot\\System32\\taskkill.exe" /PID $p.Id /T /F *> $null } catch {}; try { $p.Kill() } catch {}'));
  assert.doesNotMatch(pre, /& taskkill\.exe/);
  assert.match(pre, /\$rc = -1/);
  // timeout (-1) and crashes fall through to the same block text as before: exit 2 with "hook failed" for the blocking events
  assert.match(pre, /Console\]::Error\.WriteLine\('zn: its hook cannot start.*exit 2 # zn hook zcode$/);
  assert.match(zcodeScript('PermissionRequest'), /exit 2 # zn hook zcode$/);
  assert.match(zcodeScript('UserPromptSubmit'), /exit 2 # zn hook zcode$/);
  assert.match(zcodeScript('PostToolUse'), /systemMessage.*exit 0 # zn hook zcode$/);
  assert.doesNotMatch(zcodeScript('PostToolUse'), /exit 2 # zn hook/);
  assert.ok(cfg.isOurs(pre, 'zcode'));
  // install uses the 28 s constant
});

test('Windows launcher: install gives ZCode the deadline; other agents\' Windows launchers are unchanged', (t) => {
  const home = tempDir(t, 'zn-zc-win-deadline-');
  zc.install({ home, platform: 'win32', nodePath: 'C:/Program Files/nodejs/node.exe', runnerPath: 'C:/zn/zn-gate/lib/hooks/runner.js' });
  const h = readCfg(home).hooks.events.PreToolUse.find((x) => x.hooks.some((y) => y.command === 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')).hooks[0];
  const script = require('../lib/shell-quote').windowsCommandScript(zc.commandText(h));
  assert.ok(script.includes('.Wait(' + zc.LAUNCHER_DEADLINE_S * 1000 + ')'));
  for (const id of ['codex', 'cursor', 'gemini', 'antigravity']) {
    const s = launcher.windowsScript(id, 'PreToolUse', 'C:/node/node.exe', 'C:/z/runner.js');
    assert.doesNotMatch(s, /function zr|taskkill|Stopwatch/, id);
    assert.match(s, /& 'C:\/node\/node\.exe' 'C:\/z\/runner\.js' /, id);
  }
  assert.equal(launcher.windowsScript('codex', 'PreToolUse', 'C:/node/node.exe', 'C:/z/runner.js', {}), launcher.windowsScript('codex', 'PreToolUse', 'C:/node/node.exe', 'C:/z/runner.js'));
});

// Windows: the test reads the process id the sh script writes and checks it with process.kill(pid, 0); a Git Bash id is not a Windows id.
test('launcher deadline: a grandchild that holds the output open neither keeps the caller waiting nor outlives the launcher', { skip: !posix }, (t) => {
  const home = tempDir(t, 'zn-zc-grandchild-');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
  const cases = [
    ['hook stuck after starting a grandchild', 2, 'cat >/dev/null; sleep 60 & echo $! > PIDFILE; wait'],
    ['hook that answers and leaves a grandchild behind', 0, 'cat >/dev/null; sleep 60 & echo $! > PIDFILE; echo answer; printf ok > "$ZN_HOOK_ACK"; exit 0'],
  ];
  for (const [name, status, body] of cases) {
    const pidFile = path.join(home, 'pid-' + status);
    const node = fakeNode(t, body.replace('PIDFILE', pidFile));
    const file = launcher.writeLauncher('zcode', node, RUNNER, { home: tempDir(t, 'zn-zc-gc-h-'), env: process.env, deadlineS: 1 });
    const t0 = Date.now();
    const r = spawnLauncher(file, ['PreToolUse'], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home }, timeout: 20000 });
    assert.equal(r.status, status, name + ' ' + r.stderr);
    assert.ok(Date.now() - t0 < 5000, name + ': the caller sees the end of the output by the deadline, not after the 60 s sleep');
    if (status === 0) assert.equal(r.stdout.trim(), 'answer', name);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
    assert.equal(alive(pid), false, name + ': the grandchild is gone');
  }
});

test('launcher deadline: a hook that ignores TERM is killed (KILL) one second after the deadline', { skip: needSh }, (t) => {
  const home = tempDir(t, 'zn-zc-deadline-kill-');
  const stubborn = fakeNode(t, "trap '' TERM; cat >/dev/null; while :; do /bin/sleep 1; done");
  const file = launcher.writeLauncher('zcode', stubborn, RUNNER, { home, env: process.env, deadlineS: 2 });
  const t0 = Date.now();
  const r = spawnLauncher(file, ['PreToolUse'], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home }, timeout: 20000 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /its hook failed, so this was blocked/);
  const ms = Date.now() - t0;
  assert.ok(ms >= 2900 && ms < 9000, 'killed at deadline + 1 s, not left running (' + ms + ' ms)');
});

// Windows: child.kill('SIGTERM') ends the process at once on Windows; there is no signal for the launcher's trap to catch.
test('launcher deadline: a TERM sent to the launcher removes its private temporary files', { skip: !posix }, async (t) => {
  const home = tempDir(t, 'zn-zc-term-');
  const tmp = tempDir(t, 'zn-zc-term-tmp-');
  const hook = fakeNode(t, 'cat >/dev/null; sleep 30');
  const file = launcher.writeLauncher('zcode', hook, RUNNER, { home, env: process.env, deadlineS: 3 });
  const { spawn } = require('child_process');
  const child = spawn(file, ['PreToolUse'], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmp }, stdio: ['pipe', 'ignore', 'ignore'] });
  const closed = new Promise((resolve) => child.on('close', (code, sig) => resolve({ code, sig })));
  child.stdin.end('{}');
  const files = () => fs.readdirSync(tmp).filter((f) => /^zn-(out|err)\./.test(f));
  for (let i = 0; i < 100 && files().length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(files().length, 2, 'the launcher made its two private files');
  child.kill('SIGTERM');
  const r = await closed;
  assert.ok(r.code === 2, 'the launcher ended on TERM with the block of the event (exit 2): ' + JSON.stringify(r));
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.startsWith('zn-')), [], 'the temporary files (output and confirmation) are gone');
});

test('launcher deadline: a timer that cannot start blocks without running the hook', { skip: needSh }, (t) => {
  const home = tempDir(t, 'zn-zc-deadline-notimer-');
  const marker = path.join(home, 'ran');
  const hook = fakeNode(t, 'touch ' + marker + '; cat; exit 0');
  const file = launcher.writeLauncher('zcode', hook, RUNNER, { home, env: process.env, deadlineS: 5 });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('/bin/sleep 5 &'), 'the timer is /bin/sleep with an absolute path');
  fs.writeFileSync(file, text.split('/bin/sleep').join('/nonexistent/sleep'), { mode: 0o755 });
  const r = spawnLauncher(file, ['PreToolUse'], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home }, timeout: 20000 });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(fs.existsSync(marker), false, 'the hook did not run without a deadline');
});

test('failed install and failed uninstall leave no .bak-zn file behind', (t) => {
  const home = tempDir(t, 'zn-zc-nobak-');
  write(home, { hooks: { enabled: false } });
  const realWrite = cfg.writeJson;
  cfg.writeJson = () => { throw new Error('disk full'); };
  try {
    assert.throws(() => zc.install({ home, nodePath: '/usr/bin/node' }), /disk full/);
  } finally { cfg.writeJson = realWrite; }
  const baks = () => fs.readdirSync(path.dirname(cliFile(home))).filter((f) => f.includes('.bak-zn-'));
  assert.deepEqual(baks(), []);
  zc.install({ home, nodePath: '/usr/bin/node' });
  for (const f of baks()) fs.unlinkSync(path.join(path.dirname(cliFile(home)), f));
  cfg.writeJson = () => { throw new Error('disk full'); };
  try {
    assert.throws(() => zc.uninstall({ home }), /disk full/);
  } finally { cfg.writeJson = realWrite; }
  assert.deepEqual(baks(), []);
});
