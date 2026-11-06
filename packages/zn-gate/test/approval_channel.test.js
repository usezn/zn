'use strict';

// The commands only the person may run are confirmed on the vault's own channel when it is running.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { confirmApproval } = require('../lib/broker/approval-channel');
const { main } = require('../lib/audit/cli');
const { baselinePath } = require('../lib/audit/baseline');
const { tempDir } = require('./helpers/tmp');

const notRunning = () => Object.assign(new Error('vault locked'), { code: 'ZN_LOCKED', vaultNotRunning: true });
const unanswered = (why = 'timeout') => Object.assign(new Error('vault did not answer: ' + why), { code: 'ZN_LOCKED', vaultUnanswered: true });
const denied = () => Object.assign(new Error('declined by the user. Next step: nothing was changed.'), { code: 'ZN_POLICY_DENIED' });
const vaultThat = (fn) => ({ confirmApproval: async (...a) => fn(...a) });
const NO_ACCOUNT_VAULT = null;

test('with the vault running the answer is the vault\'s; only a vault that is not running falls back to the terminal; everything else is a refusal', async () => {
  const asked = [];
  const yes = vaultThat((...a) => { asked.push(a); return true; });
  assert.deepEqual(await confirmApproval('audit', '/p', '3 entries', { vault: yes, env: {}, accountVault: NO_ACCOUNT_VAULT }), { ok: true, via: 'vault' });
  assert.deepEqual(asked, [['audit', '/p', '3 entries']]);
  assert.deepEqual(await confirmApproval('audit', '/p', 'x', { vault: vaultThat(() => { throw notRunning(); }), env: {}, accountVault: NO_ACCOUNT_VAULT }), { ok: true, via: 'terminal' });
  for (const [label, err] of [['declined', denied()], ['timeout', unanswered('timeout')], ['connection closed', unanswered('connection closed')], ['plain locked', Object.assign(new Error('locked'), { code: 'ZN_LOCKED' })],
    ['boom', new Error('boom')], ['bad key', unanswered('bad session key')]]) {
    const r = await confirmApproval('pins', '/p', 'all', { vault: vaultThat(() => { throw err; }), env: {}, accountVault: NO_ACCOUNT_VAULT });
    assert.equal(r.ok, false, label);
    assert.match(r.error.message, /declined|did not confirm/, label);
  }
});

test('a hook\'s ZN_HOOK_VAULT_WAIT_MS refuses the approval and the vault is not even asked', async () => {
  let called = 0;
  const v = vaultThat(() => { called++; throw notRunning(); });
  for (const value of ['1', '300', '', '0']) {
    const r = await confirmApproval('audit', '/p', 'x', { vault: v, env: { ZN_HOOK_VAULT_WAIT_MS: value }, accountVault: NO_ACCOUNT_VAULT });
    assert.equal(r.ok, false, JSON.stringify(value));
  }
  assert.equal(called, 0);
});

test('a vault running at the account\'s own folder is asked when this process looks somewhere else', async () => {
  const none = vaultThat(() => { throw notRunning(); });
  const yes = vaultThat(() => true);
  assert.deepEqual(await confirmApproval('audit', '/p', 'x', { vault: none, env: {}, accountVault: yes }), { ok: true, via: 'vault' });
  const no = await confirmApproval('audit', '/p', 'x', { vault: none, env: {}, accountVault: vaultThat(() => { throw denied(); }) });
  assert.equal(no.ok, false);
  const stopped = await confirmApproval('audit', '/p', 'x', { vault: none, env: {}, accountVault: vaultThat(() => { throw unanswered('connection closed'); }) });
  assert.equal(stopped.ok, false, 'a daemon that stopped while asking is not "no vault"');
  assert.deepEqual(await confirmApproval('audit', '/p', 'x', { vault: none, env: {}, accountVault: none }), { ok: true, via: 'terminal' });
});

function setup(t) {
  const dir = tempDir(t, 'zn-ac-');
  const home = tempDir(t, 'zn-ac-home-');
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'node' } } }));
  return { dir, home };
}
async function run(args, io) {
  let out = '';
  let err = '';
  const code = await main(args, Object.assign({ stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, env: {}, stdin: { isTTY: true }, ancestry: () => null }, io));
  return { code, out, err };
}

test('zn audit --approve at a terminal: the vault decides; a vault that did not confirm records nothing; no vault running leaves the terminal check', async (t) => {
  const { dir, home } = setup(t);
  const calls = [];
  const ok = await run([dir, '--approve'], { home, vault: vaultThat((...a) => { calls.push(a); return true; }), accountVault: NO_ACCOUNT_VAULT });
  assert.equal(ok.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'audit');
  assert.ok(fs.existsSync(baselinePath(home, dir)));
  const refusals = {
    declined: denied(), timeout: unanswered('timeout'), 'closed mid-prompt': unanswered('connection closed'), 'never answers': unanswered('timeout'),
  };
  for (const [label, err] of Object.entries(refusals)) {
    const c = setup(t);
    const no = await run([c.dir, '--approve'], { home: c.home, vault: vaultThat(() => { throw err; }), accountVault: NO_ACCOUNT_VAULT });
    assert.equal(no.code, 2, label);
    assert.ok(!fs.existsSync(baselinePath(c.home, c.dir)), label + ': nothing recorded');
  }
  const hook = setup(t);
  const capped = await run([hook.dir, '--approve'], { home: hook.home, vault: vaultThat(() => { throw notRunning(); }), accountVault: NO_ACCOUNT_VAULT, env: { ZN_HOOK_VAULT_WAIT_MS: '1' } });
  assert.equal(capped.code, 2);
  assert.ok(!fs.existsSync(baselinePath(hook.home, hook.dir)));
  const redirected = setup(t);
  const other = await run([redirected.dir, '--approve'], { home: redirected.home, vault: vaultThat(() => { throw notRunning(); }), accountVault: vaultThat(() => { throw denied(); }) });
  assert.equal(other.code, 2, 'ZN_HOME elsewhere while the default daemon runs');
  assert.ok(!fs.existsSync(baselinePath(redirected.home, redirected.dir)));
  const down = setup(t);
  const fallback = await run([down.dir, '--approve'], { home: down.home, vault: vaultThat(() => { throw notRunning(); }), accountVault: NO_ACCOUNT_VAULT });
  assert.equal(fallback.code, 0, 'no vault running anywhere: the terminal check stands');
});
