'use strict';

process.env.ZN_STATS = 'off';

// GitHub Copilot CLI hooks: fixtures follow the documented contract
// (https://docs.github.com/en/copilot/reference/hooks-reference, read 2026-10-19); there is no Copilot binary here.

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

const cop = getAdapter('copilot');
const HOME = process.env.HOME || '/home/u';
const FIXTURES = path.join(__dirname, 'fixtures', 'copilot-cli');
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const FAKE_AWS = 'AKIAIOSFODNN7EXAMPLE';

function pre(toolName, toolArgs, extra = {}) {
  return { sessionId: 's1', timestamp: 1792400000000, cwd: '/work/proj', toolName, toolArgs, ...extra };
}

function run(raw) {
  return runner.handle(cop, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const E = {}; // an environment without COPILOT_HOME

test('registry lists copilot', () => {
  assert.ok(listAdapters().includes('copilot'));
});

/* ---------------------- contract fixtures (stdin -> stdout) ---------------------- */

const names = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.in.json')).map((f) => f.replace(/\.in\.json$/, ''));
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8').split('${HOME}').join(HOME.replace(/\\/g, '/')));

test('there is a fixture for preToolUse, postToolUse, userPromptSubmitted and sessionStart', () => {
  assert.ok(names.length >= 20);
  for (const n of ['pre_bash_cat_credentials', 'post_bash_secret', 'user_prompt_submitted', 'session_start']) assert.ok(names.includes(n), n);
});

for (const name of names) {
  test('fixture ' + name, async () => {
    const input = load(name + '.in.json');
    const want = load(name + '.out.json');
    const r = await run(input);
    if (want === null) {
      assert.equal(r.output, null, 'no opinion means empty output: ' + JSON.stringify(r.output));
      return;
    }
    if (want.permissionDecision) {
      assert.equal(r.output.permissionDecision, want.permissionDecision);
      assert.deepEqual(Object.keys(r.output).sort(), ['permissionDecision', 'permissionDecisionReason']);
      assert.ok(typeof r.output.permissionDecisionReason === 'string' && r.output.permissionDecisionReason.length > 0);
      return;
    }
    assert.equal(r.output.modifiedResult.resultType, 'success');
    assert.ok(!r.output.modifiedResult.textResultForLlm.includes(FAKE_AWS));
    assert.match(r.output.modifiedResult.textResultForLlm, /__ZN_/);
  });
}

test('zn never prints "allow" (no opinion is an empty output), and never rewrites arguments', async () => {
  for (const n of names) {
    const r = await run(load(n + '.in.json'));
    const s = JSON.stringify(r.output);
    assert.ok(!/"allow"|modifiedArgs|modifiedPrompt/.test(s), n + ': ' + s);
  }
});

test('the runner prints nothing at all for a no-opinion event, and the deny JSON for a denied one', () => {
  const quiet = spawnSync(process.execPath, [RUNNER, 'copilot'], { input: JSON.stringify(pre('bash', { command: 'echo hi' })), encoding: 'utf8', env: { ...process.env, ZN_STATS: 'off' } });
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, '');
  const bad = spawnSync(process.execPath, [RUNNER, 'copilot'], { input: '{not json', encoding: 'utf8', env: { ...process.env, ZN_STATS: 'off' } });
  assert.equal(bad.status, 2, 'exit 2 denies preToolUse');
  assert.equal(JSON.parse(bad.stdout).permissionDecision, 'deny');
  const empty = spawnSync(process.execPath, [RUNNER, 'copilot'], { input: '', encoding: 'utf8', env: { ...process.env, ZN_STATS: 'off' } });
  assert.equal(empty.status, 2);
});

/* ------------------------------- normalize ------------------------------- */

test('normalize: camelCase events are told apart by their fields', () => {
  assert.equal(cop.normalize(pre('bash', { command: 'ls' })).event, 'pre_tool');
  assert.equal(cop.normalize({ ...pre('bash', { command: 'ls' }), toolResult: { resultType: 'success', textResultForLlm: 'x' } }).event, 'post_tool');
  assert.equal(cop.normalize({ ...pre('bash', { command: 'ls' }), error: 'boom' }).event, null);
  assert.equal(cop.normalize({ sessionId: 's', cwd: '/', prompt: 'hi' }).event, null);
  assert.equal(cop.normalize({ sessionId: 's', cwd: '/', source: 'startup' }).event, null);
  assert.equal(cop.normalize({ hook_event_name: 'PostToolUse', tool_name: 'bash', tool_input: {}, tool_result: { result_type: 'success', text_result_for_llm: 'x' } }).event, 'post_tool');
  assert.equal(cop.normalize({ hook_event_name: 'SessionStart', source: 'startup' }).event, null);
  assert.equal(cop.normalize(null), null);
  assert.equal(cop.normalize([1]), null);
});

test('normalize: shell commands, file tools, search and web_fetch', () => {
  const b = cop.normalize(pre('bash', { command: 'ls -la' }));
  assert.equal(b.tool, 'bash');
  assert.equal(b.input.command, 'ls -la');
  assert.equal(b.cwd, '/work/proj');
  assert.equal(cop.normalize(pre('powershell', { command: 'dir' })).tool, 'powershell');
  assert.equal(cop.normalize(pre('view', { path: '/a/b' })).tool, 'read');
  const c = cop.normalize(pre('create', { path: '/a/b', file_text: '/etc/shadow' }));
  assert.equal(c.tool, 'write');
  assert.deepEqual(c.input.paths, ['/a/b'], 'content-like arguments are not paths');
  assert.equal(cop.normalize(pre('edit', { path: '/a/b', old_str: '.env', new_str: 'x' })).tool, 'write');
  const g = cop.normalize(pre('grep', { pattern: 'x', path: 'src' }));
  assert.equal(g.tool, 'grep');
  assert.equal(g.input.scanDir, path.resolve('/work/proj', 'src'));
  assert.equal(cop.normalize(pre('web_fetch', { url: 'https://example.com/a' })).tool, 'webfetch');
  // Claude-style names of the VS Code compatible spelling
  assert.equal(cop.normalize({ hook_event_name: 'PreToolUse', cwd: '/', tool_name: 'Bash', tool_input: { command: 'ls' } }).tool, 'bash');
});

test('normalize: only a successful result is handed over for rewriting', () => {
  const ok = cop.normalize({ ...pre('bash', { command: 'ls' }), toolResult: { resultType: 'success', textResultForLlm: 'out' } });
  assert.equal(ok.output, 'out');
  const bad = cop.normalize({ ...pre('bash', { command: 'ls' }), toolResult: { resultType: 'failure', textResultForLlm: 'out' } });
  assert.equal(bad.output, undefined);
});

/* ------------------------------- decisions ------------------------------- */

test('deny: a read of a credential file, a write to the vault, a shell command that reads a credential', async () => {
  const r = await run(pre('view', { path: path.join(HOME, '.aws', 'credentials') }));
  assert.equal(r.output.permissionDecision, 'deny');
  const w = await run(pre('create', { path: path.join(HOME, '.zn', 'vault.json'), file_text: 'x' }));
  assert.equal(w.output.permissionDecision, 'deny');
  const c = await run(pre('bash', { command: 'cat ~/.aws/credentials' }));
  assert.equal(c.output.permissionDecision, 'deny');
});

test('a command with secret placeholders in its arguments is denied with the environment-variable way, never rewritten', async () => {
  const r = await run(pre('bash', { command: 'curl -H "Authorization: __ZN_API_KEY__" https://example.com' }));
  assert.equal(r.output.permissionDecision, 'deny');
  assert.match(r.output.permissionDecisionReason, /run --secrets NAME -- <command>/);
  assert.equal(r.output.modifiedArgs, undefined);
});

test('deny: the agent cannot edit the files that switch the hooks off or that name more hooks', async () => {
  const files = [
    path.join(HOME, '.copilot', 'hooks', 'zn-gate.json'),
    path.join(HOME, '.copilot', 'hooks', 'other.json'),
    path.join(HOME, '.copilot', 'settings.json'),
    path.join(HOME, '.copilot', 'config.json'),
    '/work/proj/.github/hooks/zn-gate.json',
    '/work/proj/.github/copilot/settings.json',
    '/work/proj/.github/copilot/settings.local.json',
    '/etc/github-copilot/policy.d/10-org.json',
    '/work/proj/.claude/settings.json', // Copilot reads it too
  ];
  for (const f of files) {
    const r = await run(pre('edit', { path: f, old_str: 'a', new_str: 'b' }));
    assert.equal(r.output.permissionDecision, 'deny', f);
  }
  for (const cmd of ['echo {} > .github/hooks/zn-gate.json', 'rm ~/.copilot/hooks/zn-gate.json', 'sed -i s/a/b/ .github/copilot/settings.json']) {
    const r = await run(pre('bash', { command: cmd }));
    assert.equal(r.output.permissionDecision, 'deny', cmd);
  }
  // reading them is fine
  assert.equal((await run(pre('view', { path: '/work/proj/.github/hooks/zn-gate.json' }))).output, null);
});

test('fail closed: known tools with no readable command, path or arguments', async () => {
  for (const [name, args] of [['bash', {}], ['view', {}], ['create', { file_text: 'x' }], ['edit', { old_str: 'a' }], ['bash', '[1]'], ['view', '{']]) {
    const r = await run(pre(name, args));
    assert.equal(r.output.permissionDecision, 'deny', name + JSON.stringify(args));
    assert.ok(r.output.permissionDecisionReason);
  }
  assert.equal((await run(pre('glob', { pattern: '*' }))).output, null);
});

test('unknown tools that name a file get the read and write checks on every path', async () => {
  const cred = path.join(HOME, '.aws', 'credentials');
  assert.equal((await run(pre('github-read_file', { file: cred }))).output.permissionDecision, 'deny');
  assert.equal((await run(pre('future_editor', { edits: [{ path: '/work/proj/ok.js' }, { path: '/work/proj/.github/hooks/zn-gate.json' }] }))).output.permissionDecision, 'deny');
  assert.equal((await run(pre('github-search', { query: 'x', url: 'https://example.com/a' }))).output, null);
});

test('a search over a folder that holds a plain-text .env asks; a clean folder does not', async (t) => {
  const dir = tempDir(t, 'zn-cop-grep-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  assert.equal((await run(pre('grep', { pattern: 'x', path: dir }))).output, null);
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=sk_live_abcdefghijklmnop1234\n');
  const r = await run(pre('grep', { pattern: 'x', path: dir }));
  assert.equal(r.output.permissionDecision, 'ask');
  assert.match(r.output.permissionDecisionReason, /\.env/);
});

test('postToolUse: a secret in a shell result is replaced; clean and failed results are left alone', async () => {
  const r = await run({ ...pre('bash', { command: 'env' }), toolResult: { resultType: 'success', textResultForLlm: 'K=' + FAKE_AWS } });
  assert.ok(!r.output.modifiedResult.textResultForLlm.includes(FAKE_AWS));
  assert.equal(r.output.modifiedResult.resultType, 'success');
  assert.equal(typeof r.output.additionalContext, 'string');
  const bad = await run({ ...pre('bash', { command: 'env' }), toolResult: { resultType: 'failure', textResultForLlm: FAKE_AWS } });
  assert.equal(bad.output, null);
});

/* ------------------------ install / uninstall / check ------------------------ */

test('install (project): own file with version 1, preToolUse and postToolUse; idempotent; uninstall removes the file', (t) => {
  const dir = tempDir(t, 'zn-cop-');
  const rep = cop.install({ scope: 'project', projectDir: dir });
  const file = path.join(dir, '.github', 'hooks', 'zn-gate.json');
  assert.equal(rep.settings, file);
  const data = readJson(file);
  assert.equal(data.version, 1);
  assert.deepEqual(Object.keys(data.hooks).sort(), ['postToolUse', 'preToolUse']);
  assert.equal(data.hooks.preToolUse.length, 1);
  const h = data.hooks.preToolUse[0];
  assert.deepEqual(Object.keys(h), ['type', 'bash', 'powershell', 'timeoutSec']);
  assert.ok(require('../lib/agents/launcher').isProjectGuard(h.bash, 'copilot'));
  assert.ok(require('../lib/agents/launcher').isProjectWindowsScript(require('../lib/shell-quote').windowsCommandScript(h.powershell), 'copilot'));
  assert.equal(h.timeoutSec, 15);
  assert.ok(rep.warnings.some((w) => /needs zn-gate installed|zn-gate installed/.test(w)));
  cop.install({ scope: 'project', projectDir: dir });
  assert.equal(readJson(file).hooks.preToolUse.length, 1);
  assert.equal(cop.uninstall({ scope: 'project', projectDir: dir }).removed, 1);
  assert.equal(fs.existsSync(file), false);
  assert.equal(cop.uninstall({ scope: 'project', projectDir: dir }).removed, 0);
});

test('install (user): uses $COPILOT_HOME when set, backs up, keeps foreign hooks, uninstall removes only zn', (t) => {
  const home = tempDir(t, 'zn-cop-home-');
  const file = path.join(home, '.copilot', 'hooks', 'zn-gate.json');
  assert.equal(cop.hooksFile({ home, env: E }), file);
  assert.equal(cop.hooksFile({ home, env: { COPILOT_HOME: path.join(home, 'alt') } }), path.join(home, 'alt', 'hooks', 'zn-gate.json'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = { type: 'command', bash: './mine.sh', timeoutSec: 5 };
  fs.writeFileSync(file, JSON.stringify({ version: 1, hooks: { preToolUse: [mine], sessionStart: [{ type: 'prompt', prompt: 'hi' }] } }));
  const rep = cop.install({ scope: 'user', home, env: E, nodePath: '/usr/bin/node' });
  assert.ok(rep.backup && fs.existsSync(rep.backup));
  let data = readJson(file);
  assert.deepEqual(data.hooks.preToolUse[0], mine);
  assert.match(data.hooks.preToolUse[1].bash, /runner\.js'? copilot/);
  assert.equal(data.hooks.preToolUse.length, 2);
  cop.install({ scope: 'user', home, env: E, nodePath: '/usr/bin/node' });
  assert.equal(readJson(file).hooks.preToolUse.length, 2);
  cop.uninstall({ scope: 'user', home, env: E });
  data = readJson(file);
  assert.deepEqual(data, { version: 1, hooks: { preToolUse: [mine], sessionStart: [{ type: 'prompt', prompt: 'hi' }] } });
});

test('install on Windows writes a separate powershell command', (t) => {
  const home = tempDir(t, 'zn-cop-win-');
  cop.install({ scope: 'user', home, env: E, platform: 'win32', nodePath: 'C:/Program Files/nodejs/node.exe', runnerPath: 'C:/zn/zn-gate/lib/hooks/runner.js' });
  const h = readJson(cop.hooksFile({ home, env: E })).hooks.preToolUse[0];
  assert.match(h.powershell, /^powershell\.exe /);
  assert.ok(h.bash && h.bash !== h.powershell);
});

test('install removes "disableAllHooks" from its own file, and refuses another version or a bad file', (t) => {
  const dir = tempDir(t, 'zn-cop-off-');
  const file = path.join(dir, '.github', 'hooks', 'zn-gate.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, disableAllHooks: true }));
  const rep = cop.install({ scope: 'project', projectDir: dir });
  assert.equal(readJson(file).disableAllHooks, undefined);
  assert.ok(rep.warnings.some((w) => /disableAllHooks/.test(w)));
  fs.writeFileSync(file, JSON.stringify({ version: 2, hooks: {} }));
  assert.throws(() => cop.install({ scope: 'project', projectDir: dir }), /not 1/);
  fs.writeFileSync(file, '[1]');
  assert.throws(() => cop.install({ scope: 'project', projectDir: dir }), /JSON object/);
  fs.writeFileSync(file, JSON.stringify({ version: 1, hooks: [] }));
  assert.throws(() => cop.install({ scope: 'project', projectDir: dir }), /"hooks"/);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ version: 1, hooks: [] }));
});

test('zn-gate check reads the Copilot hook state (absent, set up, switched off by file and by project settings)', async (t) => {
  const check = require('../lib/check');
  const home = tempDir(t, 'zn-cop-check-');
  const cwd = tempDir(t, 'zn-cop-check-cwd-');
  const env = { PATH: process.env.PATH, HOME: home };
  const find = async () => (await check.check({ home, cwd, env, live: false })).results.find((r) => r.id === 'copilot');
  assert.equal((await find()).state, 'not-set-up');
  cop.install({ scope: 'user', home, env, nodePath: process.execPath });
  const ok = await find();
  assert.equal(ok.state, 'protected', JSON.stringify(ok));
  // project settings with disableAllHooks
  fs.mkdirSync(path.join(cwd, '.github', 'copilot'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.github', 'copilot', 'settings.local.json'), JSON.stringify({ disableAllHooks: true }));
  const off = await find();
  assert.equal(off.state, 'not-protected');
  assert.match(off.problem, /disableAllHooks/);
  fs.rmSync(path.join(cwd, '.github', 'copilot', 'settings.local.json'));
  // the hook file itself switched off
  const file = cop.hooksFile({ home, env });
  const data = readJson(file);
  data.disableAllHooks = true;
  fs.writeFileSync(file, JSON.stringify(data));
  const off2 = await find();
  assert.equal(off2.state, 'not-protected');
  assert.match(off2.problem, /disableAllHooks/);
});

test('zn-gate check runs the installed hook live against a fake secret', async (t) => {
  if (process.platform === 'win32') return;
  const check = require('../lib/check');
  const home = tempDir(t, 'zn-cop-live-');
  const cwd = tempDir(t, 'zn-cop-live-cwd-');
  const env = { PATH: process.env.PATH, HOME: home };
  cop.install({ scope: 'user', home, env, nodePath: process.execPath });
  const r = (await check.check({ home, cwd, env, live: true })).results.find((x) => x.id === 'copilot');
  assert.equal(r.state, 'protected', JSON.stringify(r));
  assert.equal(r.verified, true);
});
