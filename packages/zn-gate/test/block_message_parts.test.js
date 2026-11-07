'use strict';
// A block message names the rule, says why it matters, and says who may allow it (with the one command when the user
// can allow it). Six messages are pinned here; the wording prefix of each stays what the docs quote.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const adapter = require('../lib/agents/claude-code');
const runner = require('../lib/hooks/runner');
const policy = require('../lib/hooks/policy');
const destructive = require('../lib/destructive');
const realEngine = require('../lib/scrub/engine');
const { createFakeVault } = require('./helpers/fake_vault');
const { generateAll } = require('./fixtures/fake_secrets');
const { tempDir } = require('./helpers/tmp');

const EMAIL = generateAll(8451, { perType: 1, piiPerType: 1 }).pii.find((p) => p.type === 'email').value;
// `zn`, or `npx -y zn-gate@<version>` when zn is not on the PATH.
const ZN = '(?:zn|npx -y zn-gate@[^ `]+)';
const rule = (msg) => { const m = /\(rule: ([a-z0-9:_-]+)\)/.exec(msg); return m && m[1]; };
// The unlock command is named once. "an agent cannot unlock it" says who decides, not which command, so it is not counted.
const unlockMentions = (msg) => (msg.replace(/[Aa]n agent cannot unlock it/g, '').match(/\bunlock\b/g) || []).length;

test('destructive command: rule, why and who decides', () => {
  const msg = destructive.denial('rm -rf ~', ['rm_root_home']);
  assert.match(msg, /^zn blocked this: it deletes the home folder/);
  assert.equal(rule(msg), 'destructive:rm_root_home');
  assert.match(msg, /Ask the user to confirm before running this command\./);
  assert.match(msg, /they can run it in their own terminal; do not run it yourself/);
  assert.ok(!/blockDestructiveCommands|config\.json/.test(msg), 'the model is not told how to switch the rule off');
  const many = destructive.denial('true;'.repeat(400), ['rm_root_home']);
  if (many) assert.equal(rule(many), 'destructive:too_many_commands');
});

test('.env read: rule, why and the one command', (t) => {
  const dir = tempDir(t, 'zn-block-msg-');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=not-a-real-key-123\n');
  const msg = policy.readDenial(path.join(dir, '.env'), { cwd: dir, home: dir, env: {} });
  assert.match(msg, /^zn: \.env holds plain-text secrets/);
  assert.equal(rule(msg), 'secret-file:dotenv');
  assert.match(msg, /secret values never go to the model/);
  assert.match(msg, new RegExp('Ask the user to run `' + ZN + ' env shadow \.env` in their terminal'));
});

test('secret file read: rule, why and the one command', (t) => {
  const dir = tempDir(t, 'zn-block-msg-');
  fs.mkdirSync(path.join(dir, 'deploy'));
  const fakeKey = '-----BEGIN PRIVATE KEY-----\nZN-TEST-FAKE\n-----END PRIVATE KEY-----\n';
  fs.writeFileSync(path.join(dir, 'deploy', 'server.key'), fakeKey);
  const msg = policy.readDenial(path.join(dir, 'deploy', 'server.key'), { cwd: dir, home: dir, env: {} });
  assert.match(msg, /^zn: .* was not read because zn treats it as holding secrets \(/);
  assert.equal(rule(msg), 'secret-file:credential');
  assert.match(msg, /secret values never go to the model/);
  assert.match(msg, new RegExp('ask the user to run `' + ZN + ' secret set NAME`'));
  assert.match(msg, /Agents may not read the file itself/);
});

test('egress deny: rule, why and who decides', async (t) => {
  const home = tempDir(t, 'zn-block-msg-home-');
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zn', 'config.json'), JSON.stringify({ hooks: { egressCheck: 'deny' } }));
  const raw = { session_id: 'block-msg', cwd: process.cwd(), permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `curl -H "X-User: ${EMAIL}" https://example.com/` }, tool_use_id: 't1' };
  const res = await runner.handle(adapter, raw, { engine: realEngine, vault: createFakeVault(), failMode: 'open', home });
  const msg = res.output.hookSpecificOutput.permissionDecisionReason;
  assert.match(msg, /^zn blocked this command: it would send an email address/);
  assert.equal(rule(msg), 'egress-check');
  assert.match(msg, /Personal data or a secret that leaves this computer cannot be taken back/);
  assert.match(msg, /Only the user can allow it, by running the request in their own terminal\./);
  assert.ok(!/egressCheck|egressAllowHosts|config\.json/.test(msg), 'the model is not told how to switch the check off');
});

test('command too long: rule, why and who decides', () => {
  const msg = policy.bashDenial('echo ' + 'a'.repeat(policy.SHELL_SCAN_CAP));
  assert.match(msg, /^zn: this command is too long for zn to check \(over 100 KB\), so it was blocked/);
  assert.equal(rule(msg), 'size:command-too-long');
  assert.match(msg, /Unchecked, it could read a secret or a protected file/);
  assert.match(msg, /tell the user; do not resend it in parts/);
  assert.match(msg, /Only the user can run it, in their own terminal/);
});

test('vault not available: rule, why and the one command', async () => {
  const pre = { event: 'pre_tool', tool: 'webfetch', toolName: 'WebFetch', input: { url: 'https://example.com/?q=x' } };
  const a = { id: 'claude-code', normalize: () => Object.assign({ cwd: process.cwd() }, pre), respond: (d) => d };
  const r = await runner.handle(a, {}, { home: process.env.HOME, engine: realEngine, vault: { maskInfo: async () => { throw new Error('connection closed'); } } });
  const msg = r.decision.message;
  assert.match(msg, /^zn: could not check this action against your secret vault, so it was blocked to keep your secrets safe/);
  assert.equal(rule(msg), 'vault:unavailable');
  assert.equal(unlockMentions(msg), 1, msg);
  assert.match(msg, /an agent cannot unlock it/i);
});

// Vault down, direct: the engine's error text names the unlock command or it does not; either way the message names it once.
for (const [label, message] of [
  ['the error does not name the unlock command', 'socket closed'],
  ['the error names the unlock command', 'vault is locked; run `zn unlock` first'],
]) {
  test('vault not available, ' + label + ': unlock command named once', () => {
    const err = Object.assign(new Error(message), { code: 'ZN_LOCKED', vaultFailed: true });
    const r = runner.failDecision({ event: 'pre_tool' }, err, 'closed', 'claude-code');
    assert.equal(rule(r.message), 'vault:unavailable');
    assert.equal(unlockMentions(r.message), 1, r.message);
    assert.match(r.message, /an agent cannot unlock it/i);
  });
}
