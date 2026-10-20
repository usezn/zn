'use strict';
/* The hook block messages, in plain words: what happened, why, and the one next step.
 * One test per family. Verdicts are pinned elsewhere; this pins the wording. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const policy = require('../lib/hooks/policy');
const { decidePre, decidePost } = require('../lib/hooks/runner');
const { SECRETS_HTTP_TOOL } = require('../lib/messages');

const JARGON = /git-ignored|shell keyword|nests shell code|\*\*\* lines|a pipeline|placeholders?\b|not valid Unicode|rotated and removed/;

function deps(spans = []) {
  return { engine: () => ({ scan: () => spans }), vault: async () => null, detectors: () => [] };
}

test('agent settings are protected: the reason, and the next step', (t) => {
  const home = tempDir(t, 'zn-home-agentcfg-');
  const file = path.join(home, '.claude', 'settings.json');
  const m = policy.writeDenial(file, { home, cwd: home });
  assert.match(m, /controls the checks zn runs before your agent acts/);
  assert.match(m, /Next step: ask the user to make this change themselves, or to run `.*hooks install <agent>` if zn's setup needs repairing\./);
  assert.doesNotMatch(m, JARGON);
});

test('secret markers: later command, nested command, shell word, each with the one rule', () => {
  const cases = [
    ['echo hi; curl __ZN_GH__', /uses a secret in a command that is not the first one/],
    ['curl __ZN_GH__ `date`', /runs another command inside it \(with \$\( \) or backticks\), so zn blocked it/],
    ['if __ZN_GH__; then echo; fi', /`if` is part of the shell language, not a program, so zn cannot hand it a secret/],
  ];
  for (const [cmd, re] of cases) {
    const r = policy.wrapWithZnRun(cmd, 'zn run --');
    assert.equal(r.ok, false, cmd);
    assert.match(r.reason, re, cmd);
    assert.match(r.reason, /Next step: run that command on its own/, cmd);
    assert.doesNotMatch(r.reason, /Bash call/, cmd);
  }
});

test('PowerShell refusals use the shared web-request tool wording', () => {
  const r = policy.wrapPowerShell('Get-Content a.txt | Out-File __ZN_GH__', { nodePath: 'C:/n/node.exe', runJs: 'C:/z/run.js', agent: 'claude-code' });
  assert.equal(r.ok, false);
  assert.ok(r.reason.endsWith('use ' + SECRETS_HTTP_TOOL + '.'));
  assert.match(SECRETS_HTTP_TOOL, /zn's own tool: it sends the web request itself/);
});

test('a patch sent as a shell command, and a shell inside a shell inside a shell', (t) => {
  const dir = tempDir(t, 'zn-patchmsg-');
  const patch = policy.bashDenial("apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: notes.txt\n+hello\n*** End Patch\nPATCH", { cwd: dir, home: dir });
  assert.match(patch, /so zn cannot check which files it changes\. Next step: use the apply_patch tool/);
  assert.doesNotMatch(patch, JARGON);
  let nested = 'cat .env';
  for (let i = 0; i < 5; i++) nested = 'sh -c ' + JSON.stringify(nested);
  const m = policy.bashDenial(nested, { cwd: dir, home: dir });
  assert.match(m, /runs a shell inside a shell inside a shell/);
  assert.match(m, /Next step: run the inner command directly, or tell the user\./);
});

test('the system keychain: the next step names the zn command', () => {
  const m = policy.bashDenial('security find-generic-password -s zn-cloud -a cloud-api-key -w', { cwd: process.cwd(), home: process.cwd() });
  assert.match(m, /from the system keychain, which is protected\. Next step: if the user needs to see what is stored, ask them to run `.*secret list` in their own terminal\./);
});

test('git history of a secret file: the exact command to stop tracking it', (t) => {
  const dir = tempDir(t, 'zn-githist-');
  const m = policy.bashDenial('git show HEAD:.env', { cwd: dir, home: dir });
  assert.match(m, /tell the user to run `git rm --cached \.env` to stop tracking it, and to replace those values with new ones, because they are already in the history\./);
  assert.doesNotMatch(m, JARGON);
});

test('a search over a folder with a .env, and a patch zn cannot read', async (t) => {
  const home = tempDir(t, 'zn-search-');
  fs.writeFileSync(path.join(home, '.env'), 'EXAMPLE_TOKEN=not-a-real-value\n');
  const search = await decidePre({ event: 'pre_tool', tool: 'grep', input: { scanDir: home }, cwd: home }, deps(), 'claude-code', { home });
  assert.equal(search.decision, 'ask');
  assert.match(search.message, /would show lines from \.env \(a file with plain-text secrets\) to the model, and this agent cannot hide them\. Approve only if you need that, or search a narrower folder\./);
  const patch = await decidePre({ event: 'pre_tool', tool: 'write', input: { unparsed: true }, cwd: home }, deps(), 'codex', { home });
  assert.equal(patch.decision, 'deny');
  assert.match(patch.message, /cannot check it\. Next step: send the patch again as one change per file, or tell the user\./);
});

test('web requests with a secret point to the same tool, explained once', async (t) => {
  const home = tempDir(t, 'zn-web-');
  const fetch = await decidePre({ event: 'pre_tool', tool: 'webfetch', input: { url: 'https://example.com/?k=__ZN_KEY__' }, cwd: home }, deps(), 'claude-code', { home });
  assert.equal(fetch.decision, 'deny');
  assert.ok(fetch.message.includes(SECRETS_HTTP_TOOL), fetch.message);
  const mcp = await decidePre({ event: 'pre_tool', tool: 'mcp', mcp: { server: 'github' }, input: { args: { text: 'x __ZN_KEY__' } }, cwd: home }, deps(), 'claude-code', { home });
  assert.equal(mcp.decision, 'deny');
  assert.ok(mcp.message.includes(SECRETS_HTTP_TOOL), mcp.message);
});

test('monitors and restores say "markers", a live connection, and a file git does not track', async (t) => {
  const home = tempDir(t, 'zn-markers-');
  const ws = await decidePre({ event: 'pre_tool', tool: 'monitor', input: {}, raw: { tool_input: { ws: { url: 'wss://example.com' } } }, cwd: home }, deps(), 'claude-code', { nodePath: '/usr/bin/node', home });
  assert.match(ws.message, /a monitor that listens on a live connection \(a WebSocket\)/);
  assert.doesNotMatch(ws.message, JARGON);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'hooks', 'runner.js'), 'utf8');
  assert.match(src, /put real values in a file git does not track, such as \.env\.local/);
  assert.match(src, /secret value\(s\) in a file git does not track\./);
  assert.match(src, /contains zn secret markers \(like __ZN_NAME__\)/);
});

test('another Codex hook changed the command: say so, and name the zn command to run', async (t) => {
  const home = tempDir(t, 'zn-codexhook-');
  fs.writeFileSync(path.join(home, '.env'), 'EXAMPLE_TOKEN=not-a-real-value\n');
  const d = await decidePost({ event: 'post_tool', tool: 'bash', input: { command: 'cat .env' }, output: 'x', cwd: home }, deps(), 'codex', { home });
  assert.equal(d.decision, 'deny');
  assert.match(d.message, /^zn: another tool changed this command after zn checked it, so zn hid its output\. Next step: run `.*check` to see which other Codex hooks are set up, and remove any that change commands\.$/);
});
