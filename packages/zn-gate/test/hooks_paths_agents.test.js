'use strict';

// Path classification (normalisation, globs, substitution), protection of the
// agents' hook configuration, and the adapter changes that go with them.
// Values are fake (fixtures generator). Nothing here touches the real home.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const policy = require('../lib/hooks/policy');
const runner = require('../lib/hooks/runner');
const cfg = require('../lib/agents/config-file');
const { getAdapter } = require('../lib/agents');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { generateAll } = require('./fixtures/fake_secrets');
const { tempDir } = require('./helpers/tmp');

const FAKE = generateAll(6161, { perType: 1, piiPerType: 1 });
const AWS = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const WIN = process.platform === 'win32';

function tmpHome(t) {
  const home = tempDir(t, 'zn-paths-');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  return { home, proj };
}

function run(adapter, raw, extra = {}) {
  return runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'zn run --', ...extra });
}

const codex = getAdapter('codex');
const cursor = getAdapter('cursor');
const opencode = getAdapter('opencode');

/* ---------------------------- path normalisation ---------------------------- */

test('credential paths are found through ~, $HOME, ${HOME}, %USERPROFILE% and $env:USERPROFILE', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: {} };
  for (const p of ['~/.aws/credentials', '$HOME/.aws/credentials', '${HOME}/.aws/credentials',
    '%USERPROFILE%/.aws/credentials', '$env:USERPROFILE/.aws/credentials']) {
    assert.equal(policy.classifyPath(p, opts).kind, 'credential', p);
  }
});

test('a link inside the project to a credential file is the credential file', { skip: WIN }, (t) => {
  const { home, proj } = tmpHome(t);
  fs.mkdirSync(path.join(home, '.aws'));
  fs.writeFileSync(path.join(home, '.aws', 'credentials'), 'x\n');
  fs.symlinkSync(path.join(home, '.aws', 'credentials'), path.join(proj, 'notes.txt'));
  assert.equal(policy.classifyPath('notes.txt', { home, cwd: proj, env: {} }).kind, 'credential');
});

test('case is ignored on Windows and macOS, and kept on Linux', (t) => {
  const { home, proj } = tmpHome(t);
  const upper = path.join(home, '.AWS', 'CREDENTIALS');
  const c = policy.classifyPath(upper, { home, cwd: proj, env: {} });
  assert.equal(c ? c.kind : null, CASE_INSENSITIVE ? 'credential' : null);
});

test('credential environment variables name credential paths, set or not', (t) => {
  const { home, proj } = tmpHome(t);
  const kube = path.join(home, 'kube', 'cluster.yaml');
  const opts = { home, cwd: proj, env: {} };
  // Not set here: the variable itself is enough.
  assert.equal(policy.classifyPath('$KUBECONFIG', opts).kind, 'credential');
  assert.equal(policy.classifyPath('${AZURE_CONFIG_DIR}/token.json', opts).kind, 'credential');
  // Set: its value is a credential file, and so is a path equal to it.
  const env = { KUBECONFIG: kube, AZURE_CONFIG_DIR: path.join(home, 'azure') };
  assert.equal(policy.classifyPath(kube, { home, cwd: proj, env }).kind, 'credential');
  assert.equal(policy.classifyPath(path.join(home, 'azure', 'x.json'), { home, cwd: proj, env }).kind, 'credential');
  assert.equal(policy.classifyPath(path.join(home, 'notes', 'x.txt'), { home, cwd: proj, env }), null);
});

/* ------------------------------ globs and braces ------------------------------ */

test('a glob or brace list that could name a credential is treated as naming it', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: {} };
  assert.equal(policy.classifyWord('~/.aws/cred*', opts).kind, 'credential');
  assert.equal(policy.classifyWord('~/.aws/cred{entials,s}', opts).kind, 'credential');
  assert.equal(policy.classifyWord('~/.a?s/credentials', opts).kind, 'credential');
  assert.equal(policy.classifyWord('~/.ssh/id_*', opts).kind, 'credential');
  assert.equal(policy.classifyWord('~/.zn/*', opts).kind, 'zn_state');
  assert.equal(policy.classifyWord('.e*', opts).kind, 'credential', 'a .env pattern in the project');
  assert.equal(policy.classifyWord('~/Documents/*.txt', opts), null);
  assert.equal(policy.classifyWord('src/*.js', opts), null);
  assert.deepEqual(policy.expandBraces('a{b,c}d'), ['abd', 'acd']);
  assert.equal(policy.expandBraces('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}'), null, 'too many alternatives');
});

test('a shell command with a glob on a credential path is refused', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: {} };
  assert.match(policy.bashDenial('cat ~/.aws/cred*', opts), /credential/);
  assert.match(policy.bashDenial('cat ~/.aws/cred{entials,s}', opts), /credential/);
  assert.equal(policy.bashDenial('ls ~/Documents/*.txt', opts), null);
});

test('command substitution: the words inside $( ) and backticks are checked too', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: {} };
  assert.match(policy.bashDenial('echo $(cat ~/.aws/credentials)', opts), /credential/);
  assert.match(policy.bashDenial('echo `cat ~/.aws/credentials`', opts), /credential/);
  assert.match(policy.bashDenial('cat "$KUBECONFIG"', opts), /credential/);
  assert.equal(policy.bashDenial('echo $(date)', opts), null);
});

test('a Windows path with backslashes is classified: the separators are not shell escapes', () => {
  // Built from strings, so the test is the same on every system.
  const opts = { home: 'C:\\Users\\me', cwd: 'C:\\Users\\me\\proj', env: {} };
  assert.match(policy.bashDenial('type C:\\Users\\me\\.aws\\credentials', opts), /credential/);
  assert.match(policy.bashDenial('Get-Content "C:\\Users\\me\\.aws\\credentials"', opts), /credential/);
  assert.equal(policy.bashDenial('Get-Content C:\\Users\\me\\proj\\src\\app.js', opts), null);
});

test('a --option=path carries its path too', (t) => {
  const { home, proj } = tmpHome(t);
  assert.match(policy.bashDenial('kubectl get pods --kubeconfig=~/.kube/config', { home, cwd: proj, env: {} }), /credential/);
});

/* ------------------------ agent hook configuration ------------------------ */

test('the agents hook and plugin configuration cannot be written, but can be read', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: {} };
  const protectedFiles = [
    path.join(home, '.claude', 'settings.json'),
    path.join(proj, '.claude', 'settings.local.json'),
    path.join(home, '.codex', 'hooks.json'),
    path.join(home, '.cursor', 'hooks.json'),
    path.join(proj, 'opencode.json'),
    path.join(home, '.config', 'opencode', 'plugins', 'zn-gate.js'),
    path.join(proj, '.opencode', 'plugins', 'zn-gate.js'),
  ];
  for (const f of protectedFiles) {
    assert.match(policy.writeDenial(f, opts), /protected/, f);
    assert.equal(policy.readDenial(f, opts), null, f);
  }
  assert.equal(policy.writeDenial(path.join(proj, 'src', 'app.js'), opts), null);
});

test('shell commands cannot write the agents hook configuration', (t) => {
  const { home, proj } = tmpHome(t);
  const opts = { home, cwd: proj, env: {} };
  assert.match(policy.bashDenial('echo {} > ~/.claude/settings.json', opts), /protected/);
  assert.match(policy.bashDenial('sed -i s/a/b/ ~/.cursor/hooks.json', opts), /protected/);
  assert.match(policy.bashDenial('cat ~/.claude/settings.json > /dev/null; rm ~/.claude/settings.json', opts), /protected/);
  assert.match(policy.bashDenial('python3 -c "open(\'.cursor/hooks.json\',\'w\')"', opts), /protected/);
  assert.equal(policy.bashDenial('cat ~/.claude/settings.json', opts), null, 'reading is allowed');
  assert.equal(policy.bashDenial('ls -la', opts), null);
});

test('a Codex patch is refused when any file in it is protected, and an unreadable patch too', async (t) => {
  const { home, proj } = tmpHome(t);
  const settings = path.join(home, '.claude', 'settings.json');
  const cx = (patch) => ({ session_id: 's', transcript_path: '/t', cwd: proj, hook_event_name: 'PreToolUse', model: 'm', tool_name: 'apply_patch', tool_input: { command: patch } });
  const ok = await run(codex, cx('*** Begin Patch\n*** Update File: src/a.js\n@@\n-a\n+b\n*** End Patch'), { home });
  assert.notEqual(ok.output && ok.output.hookSpecificOutput && ok.output.hookSpecificOutput.permissionDecision, 'deny');
  const second = await run(codex, cx('*** Begin Patch\n*** Update File: src/a.js\n*** Add File: ' + settings + '\n+x\n*** End Patch'), { home });
  assert.equal(second.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(second.output.hookSpecificOutput.permissionDecisionReason, /protected/);
  const unreadable = await run(codex, cx('not a patch'), { home });
  assert.equal(unreadable.output.hookSpecificOutput.permissionDecision, 'deny');
});

test('Codex tokenizes the output of tools it does not know, like MCP output', async (t) => {
  const { home, proj } = tmpHome(t);
  const raw = { session_id: 's', transcript_path: '/t', cwd: proj, hook_event_name: 'PostToolUse', model: 'm',
    tool_name: 'web_search', tool_use_id: 'u1', tool_input: {}, tool_response: 'found key=' + AWS };
  const res = await run(codex, raw, { home });
  assert.equal(res.output.decision, 'block');
  assert.ok(!res.output.reason.includes(AWS));
});

test('the hook reads an event that starts with a byte order mark (Windows PowerShell pipes one)', (t) => {
  const { spawnSync } = require('child_process');
  const { home, proj } = tmpHome(t);
  const ev = { session_id: 's', transcript_path: '/t', cwd: proj, hook_event_name: 'PreToolUse', model: 'm', tool_name: 'Bash',
    tool_input: { command: 'cat ' + path.join(home, '.aws', 'credentials') } };
  const res = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js'), 'codex'], {
    input: '﻿' + JSON.stringify(ev), env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /"permissionDecision":"deny"/);
  assert.doesNotMatch(res.stderr, /invalid event JSON/);
});

test('Cursor preToolUse checks the file a write, delete or grep names, and fails closed without a path', async (t) => {
  const { home, proj } = tmpHome(t);
  const pre = (tool, input) => ({ hook_event_name: 'preToolUse', tool_name: tool, tool_input: input, cwd: proj, conversation_id: 'c' });
  const denied = await run(cursor, pre('Write', { file_path: path.join(home, '.cursor', 'hooks.json'), content: 'x' }), { home });
  assert.equal(denied.output.permission, 'deny');
  const del = await run(cursor, pre('Delete', { file_path: path.join(home, '.codex', 'hooks.json') }), { home });
  assert.equal(del.output.permission, 'deny');
  const grep = await run(cursor, pre('Grep', { pattern: 'x', path: path.join(home, '.aws', 'credentials') }), { home });
  assert.equal(grep.output.permission, 'deny');
  // An allowed write gets no answer: "allow" could skip Cursor's own confirmations.
  const ok = await run(cursor, pre('Write', { file_path: path.join(proj, 'src', 'a.js'), content: 'x' }), { home });
  assert.equal(ok.output, null);
  const noPath = await run(cursor, pre('Write', { content: 'x' }), { home });
  assert.equal(noPath.output.permission, 'deny', 'a write whose path cannot be read is refused');
});

test('Cursor install: failClosed on beforeReadFile and beforeSubmitPrompt, and a matcher on preToolUse', (t) => {
  const { home, proj } = tmpHome(t);
  cursor.install({ home, scope: 'user', nodePath: process.execPath, runnerPath: '/opt/zn/runner.js' });
  const data = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8'));
  assert.equal(data.hooks.beforeReadFile[0].failClosed, true);
  assert.equal(data.hooks.beforeSubmitPrompt[0].failClosed, true);
  assert.equal(data.hooks.beforeShellExecution[0].failClosed, undefined);
  assert.equal(data.hooks.preToolUse[0].matcher, 'Grep|Write|Delete');
  assert.ok(data.hooks.preToolUse[0].command.includes('/opt/zn/runner.js'));
  void proj;
});

test('OpenCode: a command runs from its workdir, apply_patch names every file, and output of its text tools is tokenized', () => {
  const pre = opencode.normalize({ hook: 'tool.execute.before', tool: 'bash', args: { command: 'ls', workdir: 'sub' }, cwd: '/proj' });
  assert.equal(pre.cwd, path.resolve('/proj', 'sub'));
  const patch = opencode.normalize({ hook: 'tool.execute.before', tool: 'apply_patch', args: { patchText: '*** Begin Patch\n*** Update File: a.js\n*** Add File: b.js\n*** End Patch' }, cwd: '/proj' });
  assert.deepEqual(patch.input.paths, ['a.js', 'b.js']);
  assert.equal(opencode.normalize({ hook: 'tool.execute.before', tool: 'apply_patch', args: { patchText: 'nothing' }, cwd: '/proj' }).input.unparsed, true);
  for (const t of ['task', 'websearch', 'glob', 'list', 'skill', 'codesearch']) {
    assert.equal(opencode.normalize({ hook: 'tool.execute.after', tool: t, args: {}, output: 'x', cwd: '/proj' }).tool, 'mcp', t);
  }
});

test('OpenCode plugin: only known actions are acted on, and a project plugin names no path of this user', () => {
  const user = opencode.pluginSource({ nodePath: '/usr/bin/node', runnerPath: '/opt/zn/runner.js', scope: 'user' });
  assert.match(user, /const ACTIONS = \["none", "deny", "error", "args", "output"\];/);
  assert.match(user, /!ACTIONS\.includes\(answer\.action\)/);
  assert.ok(user.includes('/opt/zn/runner.js'));
  const project = opencode.pluginSource({ nodePath: '/usr/bin/node', runnerPath: '/opt/zn/runner.js', scope: 'project' });
  assert.match(project, /const NODE = "zn";/);
  assert.ok(!project.includes('/opt/zn/runner.js'));
  assert.ok(!project.includes('/usr/bin/node'));
});

/* ------------------------------ install files ------------------------------ */

test('config files: a symlinked file is written through, its mode is kept, and bad content is refused', { skip: WIN }, (t) => {
  const dir = tempDir(t, 'zn-cfg-');
  const target = path.join(dir, 'real.json');
  const link = path.join(dir, 'link.json');
  fs.writeFileSync(target, '{}\n', { mode: 0o600 });
  fs.symlinkSync(target, link);
  cfg.writeJson(link, { hooks: {} });
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link stays');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { hooks: {} });

  fs.writeFileSync(path.join(dir, 'null.json'), 'null');
  assert.throws(() => cfg.readJson(path.join(dir, 'null.json')), /must hold a JSON object, not null/);
  fs.writeFileSync(path.join(dir, 'arr.json'), '[]');
  assert.throws(() => cfg.readJson(path.join(dir, 'arr.json')), /not an array/);
  assert.throws(() => cfg.hooksOf({ hooks: [] }, 'x.json'), /"hooks" in x\.json must be an object/);
  assert.deepEqual(cfg.hooksOf({}, 'x.json'), {});
  assert.deepEqual(cfg.hooksOf({ hooks: null }, 'x.json'), {});
});

test('hook commands: a project install names zn on PATH, and paths are single-quoted for sh', () => {
  assert.equal(cfg.hookCommand('codex', { scope: 'project', nodePath: '/n/node', runnerPath: '/r/runner.js' }), 'zn hook codex');
  assert.equal(cfg.hookCommandWindows('codex', { scope: 'project' }), 'zn hook codex');
  assert.equal(cfg.quoteArg('/a$b/`x`/c', 'linux'), "'/a$b/`x`/c'");
  const user = cfg.hookCommand('codex', { scope: 'user', nodePath: '/n/node', runnerPath: '/r/runner.js', platform: 'linux' });
  assert.equal(user, "'/n/node' '/r/runner.js' codex");
  const win = cfg.hookCommandWindows('codex', { scope: 'user', nodePath: 'C:\\Program Files\\nodejs\\node.exe', runnerPath: "C:\\it's\\runner.js" });
  assert.match(win, /^powershell\.exe -NoProfile -NonInteractive -Command "& 'C:\/Program Files\/nodejs\/node\.exe' 'C:\/it''s\/runner\.js' codex"$/);
});
