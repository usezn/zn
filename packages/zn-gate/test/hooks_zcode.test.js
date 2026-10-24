'use strict';

process.env.ZN_STATS = 'off';

// Zcode (z.ai) hooks: fixtures follow the contract in the Zcode docs and source (https://zcode.z.ai/en/docs/hooks and
// github.com/zai-org/ZCode, apps/zcode-cli, read 2026-10-24): stdin carries both camelCase fields and the snake_case
// aliases, and an answer must pass Zcode's own output schema or the hook fails and the tool runs. There is no
// Zcode binary here; the answers are checked against a copy of that schema (validZcodeOutput).

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

const zc = getAdapter('zcode');
const HOME = process.env.HOME || '/home/u';
const FIXTURES = path.join(__dirname, 'fixtures', 'zcode');
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const posix = process.platform !== 'win32';

function run(raw) {
  return runner.handle(zc, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
}

const cliFile = (home) => path.join(home, '.zcode', 'cli', 'config.json');
const readCfg = (home) => JSON.parse(fs.readFileSync(cliFile(home), 'utf8'));
const write = (home, obj) => {
  fs.mkdirSync(path.dirname(cliFile(home)), { recursive: true });
  fs.writeFileSync(cliFile(home), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
};

// The hook output schema of Zcode (contracts/src/hooks/index.ts: HookJSONOutputSchema), reduced to the keys zn uses.
function validZcodeOutput(out, event) {
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
  assert.equal(getAdapter('Zcode').id, 'zcode');
  assert.equal(getAdapter('zai').id, 'zcode');
});

/* ---------------------- contract fixtures (stdin -> stdout) ---------------------- */

const names = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.in.json')).map((f) => f.replace(/\.in\.json$/, ''));
const readFixture = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8').split('${HOME}').join(HOME.replace(/\\/g, '/')));

test('there are fixtures for every event zn registers and for events it ignores', () => {
  const events = new Set(names.map((n) => readFixture(n + '.in.json').hook_event_name));
  for (const ev of [...zc.EVENTS, 'SessionStart', 'Stop']) assert.ok(events.has(ev), ev);
  // Both spellings are in every payload, as Zcode sends them.
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
    validZcodeOutput(r.output, want.shape === 'prompt_block' ? 'UserPromptSubmit' : want.shape === 'post_notice' ? 'PostToolUse' : input.hook_event_name);
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
      assert.match(r.output.hookSpecificOutput.additionalContext, /Zcode cannot hide tool output/);
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
  validZcodeOutput(r.output, 'PreToolUse');
  assert.equal(r.output.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(r.output.hookSpecificOutput.permissionDecisionReason, /\.env/);
  // PermissionRequest never answers an ask: the prompt stays as it is.
  assert.equal((await run({ ...pre('Grep', { pattern: 'x', path: dir }), hook_event_name: 'PermissionRequest' })).output, null);
});

test('a command already wrapped in zn run asks the user; PermissionRequest stays silent', async () => {
  const cmd = 'zn run -- node -e "console.log(1)" __ZN_DB_PASSWORD__';
  const wrapped = await run(pre('Bash', { command: cmd }));
  assert.equal(wrapped.decision.decision, 'ask');
  validZcodeOutput(wrapped.output, 'PreToolUse');
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
  write(home, { mcp: { servers: { secrets: { type: 'stdio', command: 'zn', args: ['secrets-mcp'], enabled: false } } } });
  assert.equal(ev().ours, undefined, 'a disabled server is not what ran');
  assert.equal(zc.normalize(pre('mcp__other__secrets_list', {})).mcp.ours, undefined);
});

test('PostToolUse: a notice for a secret in the output, nothing for clean output; the output is never rewritten', async () => {
  const mk = (resp) => ({ hook_event_name: 'PostToolUse', session_id: 's', cwd: '/work/proj', tool_name: 'Bash', tool_input: { command: 'env' }, tool_use_id: 'u', tool_response: resp });
  const hit = await run(mk({ stdout: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE' }));
  validZcodeOutput(hit.output, 'PostToolUse');
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

test('the watchdog answers before Zcode\'s own timeout', () => {
  assert.ok(zc.HOOK_TIMEOUT_S >= 10);
  assert.equal(zc.HOOK_TIMEOUT_MS, zc.HOOK_TIMEOUT_S * 1000);
  assert.ok(zc.HOOK_TIMEOUT_MS < 60000, 'below Zcode\'s default timeout of 60000 ms');
  assert.ok(runner.postDeadlineMs('zcode') < zc.HOOK_TIMEOUT_MS);
});

for (const [event, payload, check] of [
  ['PreToolUse', pre('Bash', { command: 'echo hi' }), (o) => assert.equal(o.hookSpecificOutput.permissionDecision, 'deny')],
  ['PermissionRequest', { ...pre('Bash', { command: 'echo hi' }), hook_event_name: 'PermissionRequest' }, (o) => assert.equal(o.hookSpecificOutput.decision.behavior, 'deny')],
  ['UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/w', prompt: 'hello' }, (o) => assert.equal(o.continue, false)],
]) {
  test('zcode ' + event + ': a hung or crashing check is answered with deny and exit 2 (Zcode would otherwise run the call)', (t) => {
    for (const fault of [{ ZN_TEST_HOOK_FAULT: 'hang', ZN_TEST_HOOK_HANG_MS: '30000', ZN_TEST_HOOK_DEADLINE_MS: '800' }, { ZN_TEST_HOOK_FAULT: 'throw' }]) {
      const r = spawnHook(t, payload, fault);
      assert.equal(r.status, 2, r.stderr);
      const out = JSON.parse(r.stdout);
      validZcodeOutput(out, event);
      check(out);
      assert.ok(r.ms < 10000, 'answered in ' + r.ms + ' ms');
    }
  });
}

/* --------------------------- install / uninstall -------------------------- */

test('install (user) writes the four events with process hooks, turns hooks on, registers the MCP server and backs up', { skip: !posix }, (t) => {
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
    // Only the keys Zcode's strict schema knows: a stray key would make it drop the whole file.
    assert.ok(Object.keys(g).every((k) => ['matcher', 'hooks'].includes(k)), ev);
    assert.equal(g.hooks.length, 1);
    assert.deepEqual(g.hooks[0], { type: 'process', command: file, args: [ev], timeoutMs: zc.HOOK_TIMEOUT_MS, statusMessage: zc.HOOK_STATUS });
  }
  assert.equal(data.hooks.events.PreToolUse[1].matcher, '*');
  assert.equal(data.hooks.events.UserPromptSubmit[0].matcher, undefined);
  assert.deepEqual(data.mcp.servers.other, mine.mcp.servers.other);
  const s = data.mcp.servers.secrets;
  assert.equal(s.type, 'stdio');
  assert.equal(s.command, '/usr/bin/node');
  assert.deepEqual(s.args.slice(1), ['secrets-mcp', '--agent', 'zcode']);
  assert.equal(rep.mcp, cliFile(home));
  assert.ok(fs.statSync(file).mode & 0o100, 'the launcher is executable (Zcode starts a process hook directly, with no shell)');
});

test('install is idempotent and uninstall removes only zn: the user\'s hooks, settings and MCP servers stay', { skip: !posix }, (t) => {
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
  assert.ok(fs.existsSync(launcher.launcherFile('zcode', { home, env: process.env })), 'the launcher is shared: only the machine-wide uninstall removes it');
  zc.install({ home, nodePath: '/usr/bin/node' });
  zc.uninstall({ home, removeLauncher: true });
  assert.equal(fs.existsSync(launcher.launcherFile('zcode', { home, env: process.env })), false);
});

test('uninstall from a config zn created leaves no hooks or mcp keys behind; a hook of the user in the same group stays', { skip: !posix }, (t) => {
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

test('an MCP server called "secrets" that is not zn\'s is left alone, on install and on uninstall', { skip: !posix }, (t) => {
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

test('there is no project install: Zcode ignores project hooks', (t) => {
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
  const g = readCfg(home).hooks.events.PreToolUse.find((x) => x.hooks.some((h) => h.command === 'powershell.exe'));
  const h = g.hooks[0];
  assert.equal(h.type, 'process');
  assert.deepEqual(h.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = require('../lib/shell-quote').windowsCommandScript(zc.commandText(h));
  assert.match(script, /runner\.js.* zcode; if \(\$LASTEXITCODE -eq 0 -or \$LASTEXITCODE -eq 2\) \{ exit \$LASTEXITCODE \}/);
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
  assert.match(all, /new Zcode session/);
  assert.doesNotMatch(zc.install({ home, nodePath: '/usr/bin/node' }).warnings.join('\n'), /zn turned it on/);
  write(home, { features: { mcp: false } });
  assert.match(zc.install({ home, nodePath: '/usr/bin/node' }).warnings.join('\n'), /features\.mcp/);
});

/* -------------------------------- launcher -------------------------------- */

test('launcher: with the Node.js gone the events that can deny exit 2 with the repair step; PostToolUse only warns', { skip: !posix }, (t) => {
  const home = tempDir(t, 'zn-zc-launch-');
  zc.install({ home, nodePath: '/nonexistent/node-gone/bin/node', runnerPath: RUNNER });
  const data = readCfg(home);
  const bin = tempDir(t, 'zn-zc-bin-');
  for (const ev of ['PreToolUse', 'PermissionRequest', 'UserPromptSubmit']) {
    const h = data.hooks.events[ev][0].hooks[0];
    // Zcode starts a "process" hook with the file and its arguments, no shell.
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

test('launcher: with the recorded Node.js it runs the real hook, and a deny comes out as the PreToolUse JSON', { skip: !posix }, (t) => {
  const home = tempDir(t, 'zn-zc-real-');
  zc.install({ home, nodePath: process.execPath, runnerPath: RUNNER });
  const h = readCfg(home).hooks.events.PreToolUse[0].hooks[0];
  const dir = tempDir(t, 'zn-zc-proj-');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=sk-test-EXAMPLE0000000000000000\n');
  const ev = pre('Read', { file_path: path.join(dir, '.env') }, { cwd: dir });
  const r = spawnSync(h.command, h.args, { input: JSON.stringify(ev), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ZN_STATS: 'off' } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  validZcodeOutput(out, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

/* ------------------------------ zn-gate check ----------------------------- */

test('zn-gate check reads the Zcode install state (absent, set up) and runs the installed hook', { skip: !posix }, async (t) => {
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

test('zn-gate check warns when hooks.enabled is false or not set, or when an entry of zn\'s is switched off', { skip: !posix }, async (t) => {
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

test('zn-gate check: a Node.js that is gone is reported with the repair step', { skip: !posix }, async (t) => {
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

/* --------------------- measured on zcode-cli 0.17.0 (ZCode commit 3c5b2276) --------------------- */

test('measured: respond() answers a denied prompt with continue:false and no hookSpecificOutput', () => {
  const ev = zc.normalize({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/w', prompt: 'x' });
  const out = zc.respond({ decision: 'deny', message: 'blocked', event: ev });
  assert.deepEqual(out, { continue: false, reason: 'blocked' });
});

test('measured: PermissionRequest only ever gets deny, whatever the internal decision (allow would skip the approval screen)', () => {
  const ev = zc.normalize({ hook_event_name: 'PermissionRequest', session_id: 's', cwd: '/w', tool_name: 'Bash', tool_input: { command: 'ls' } });
  for (const d of [{ decision: 'allow' }, { decision: 'ask', message: 'q' }, { decision: 'allow', updatedInput: { command: 'x' }, kind: 'wrap' }, { decision: 'deny', message: 'no' }]) {
    const out = zc.respond({ ...d, event: ev });
    if (out === null) continue;
    assert.equal(out.hookSpecificOutput.decision.behavior, 'deny', JSON.stringify(d));
  }
  assert.equal(zc.respond({ decision: 'allow', event: ev }), null);
});

test('measured: the camelCase fields alone are read like the snake_case ones, and tool names seen at run time map to the checks', () => {
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

test('measured: the agent is the one the launcher names; the CLAUDE_* variables Zcode sets change nothing', (t) => {
  const home = tempDir(t, 'zn-zc-env-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off', CLAUDE_PROJECT_DIR: '/w', CLAUDE_SESSION_ID: 's', CLAUDE_CODE_SESSION_ID: 's', ZCODE_PROJECT_DIR: '/w', ZCODE_SESSION_ID: 's' };
  delete env.CLAUDECODE;
  const payload = { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/w', tool_name: 'Read', tool_input: { file_path: path.join(home, '.aws', 'credentials') }, tool_use_id: 'u' };
  const r = spawnSync(process.execPath, [RUNNER, 'zcode'], { input: JSON.stringify(payload), encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  validZcodeOutput(out, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('measured: hooks fire inside subagents too, so several hooks at once in one home all answer (no lock that deadlocks)', async (t) => {
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

test('measured: the hooks.enabled warning says the hooks of that file do not run (plugin hooks do), not all hooks', (t) => {
  const home = tempDir(t, 'zn-zc-warn-');
  write(home, { hooks: { enabled: false } });
  const w = zc.configWarnings({ home });
  assert.match(w.problems[0], /"hooks\.enabled" is false/);
  assert.match(w.problems[0], /none of the hooks in that file/);
});
