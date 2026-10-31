'use strict';
/* Covers the message functions of lib/messages.js that test/messages.test.js does not pin word for word,
 * and checks that no message contains an absolute home path. Inputs are fake values. */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const m = require('../lib/messages');

const ZN = '(?:zn|npx -y zn-gate@\\S+)';
const VERBOSE = { ZN_VERBOSE: '1' };
const QUIET = {};

function re(source) {
  return new RegExp('^' + source.replace(/@ZN@/g, ZN) + '$');
}

test('keychainProblem names the keychain, the action and the next step', () => {
  const mac = m.keychainProblem('macos', 'read', { env: QUIET });
  assert.match(mac, /^zn could not read the vault key in the macOS Keychain\. If a Keychain window asked/);
  assert.ok(mac.includes('"zn-vault"'));
  assert.ok(!mac.includes('passphrase'));
  assert.match(m.keychainProblem('windows', 'read', { env: QUIET }), /in the Windows Credential Manager\. Check that Credential Manager works/);
  assert.match(m.keychainProblem('libsecret', 'read', { env: QUIET }), /in your Linux keyring \(Secret Service\)\. Make sure your keyring is unlocked/);
});

test('keychainProblem offers a passphrase only when saving the vault key', () => {
  assert.match(m.keychainProblem('libsecret', 'save', { env: QUIET }),
    re('zn could not save the vault key in .*\\. Make sure .* Or create the vault with a passphrase instead: `@ZN@ unlock --backend passphrase`\\.'));
  const connect = m.keychainProblem('libsecret', 'save', { slotIsVault: false, env: QUIET });
  assert.ok(connect.startsWith('zn could not save the zn-gate connect key in '));
  assert.ok(!connect.includes('passphrase'));
});

test('keychainProblem falls back to generic words for an unknown backend', () => {
  assert.equal(m.keychainProblem('other', 'read', { env: QUIET }), 'zn could not read the vault key in the system keychain. ');
});

test('keychainProblem shows the detail only in verbose mode', () => {
  assert.ok(m.keychainProblem('macos', 'read', { detail: 'fake detail', env: VERBOSE }).endsWith(' Detail: fake detail.'));
  assert.ok(!m.keychainProblem('macos', 'read', { detail: 'fake detail', env: QUIET }).includes('fake detail'));
});

test('keychain helper and tool messages', () => {
  assert.match(m.secretToolMissing(),
    re('zn needs the secret-tool program to use your Linux keyring, and it is not installed\\. Install the libsecret-tools package \\(for example: sudo apt install libsecret-tools\\), or create the vault with a passphrase instead: `@ZN@ unlock --backend passphrase`\\.'));
  assert.match(m.powershellMissing(),
    re('zn could not find Windows PowerShell, which it needs to use the Windows Credential Manager\\. Create the vault with a passphrase instead: `@ZN@ unlock --backend passphrase`\\.'));
  assert.match(m.keychainHelperFailed('fake detail', QUIET),
    re('zn could not start the system program that holds its key\\. Close this terminal, open a new one and try again\\. If it keeps failing, create the vault with a passphrase instead: `@ZN@ unlock --backend passphrase`\\.'));
  assert.ok(m.keychainHelperFailed('fake detail', VERBOSE).endsWith(' Detail: fake detail.'));
});

test('keychainLostKey is a save problem whose detail is verbose only', () => {
  assert.equal(m.keychainLostKey('windows', QUIET), m.keychainProblem('windows', 'save', { env: QUIET }));
  assert.ok(m.keychainLostKey('windows', VERBOSE).endsWith(' Detail: the keychain did not return the key it was given.'));
});

test('vault process messages', () => {
  assert.match(m.vaultStartTimeout(),
    re('The vault did not start in time\\. Run `@ZN@ lock`, then `@ZN@ unlock` again\\. More: https://usezn\\.com/docs/zn-gate/troubleshooting/'));
  assert.match(m.vaultStartExited(3, QUIET),
    re('The vault stopped while it was starting\\. Run `@ZN@ unlock` again\\. More: https://usezn\\.com/docs/zn-gate/troubleshooting/'));
  assert.ok(m.vaultStartExited(3, VERBOSE).endsWith(' Detail: exit code 3.'));
  assert.match(m.vaultNotAnswering('fake detail', QUIET), re('The vault is not answering\\. Run `@ZN@ lock`, then `@ZN@ unlock`\\.'));
  assert.ok(m.vaultNotAnswering('fake detail', VERBOSE).endsWith(' Detail: fake detail.'));
  assert.match(m.vaultAlreadyUnlocked(),
    re('The vault is already unlocked, so there is nothing to do\\. To unlock it again, run `@ZN@ lock` in your own terminal first\\.'));
});

test('auditFailed names the record and says not to edit the log', () => {
  const text = m.auditFailed(42, 'fake error', QUIET);
  assert.equal(text, 'The audit log did not pass its check (at record 42). Do not delete or edit it: it is the proof of what happened. More: ' + m.TROUBLESHOOTING_URL);
  assert.ok(m.auditFailed(42, 'fake error', VERBOSE).endsWith(' Detail: fake error.'));
});

test('vaultLockedBecause explains each reason', () => {
  assert.equal(m.vaultLockedBecause('idle', 15), 'Vault locked: it was not used for 15 min.');
  assert.equal(m.vaultLockedBecause('expired'), 'Vault locked: the time you set with --ttl ran out.');
  assert.equal(m.vaultLockedBecause('manual'), 'Vault locked.');
  assert.equal(m.vaultLockedBecause(), 'Vault locked.');
});

test('connectUnverified: a refusal sentence is kept and ends with the saved note', () => {
  assert.equal(m.connectUnverified('EXAMPLE_VAR is set, so this was refused.', QUIET),
    'EXAMPLE_VAR is set, so this was refused. Nothing was saved.');
  assert.match(m.connectUnverified('', QUIET), /^Could not reach usezn\.com/);
  assert.match(m.connectUnverified(undefined, QUIET), /^Could not reach usezn\.com/);
  assert.ok(m.connectUnverified('HTTP 502', VERBOSE).endsWith(' Detail: HTTP 502.'));
});

test('revokeNotReached covers network, server and local refusals', () => {
  const dash = 'https://dashboard.example.com';
  assert.equal(m.revokeNotReached('ETIMEDOUT', 'zn_...abcd', dash, QUIET),
    'Could not reach usezn.com, so key zn_...abcd was not revoked. Check your internet connection and run `zn-gate disconnect --revoke` again, or revoke it yourself at ' + dash + '.');
  assert.equal(m.revokeNotReached('HTTP 500', 'zn_...abcd', dash, QUIET),
    'usezn.com is not answering properly right now, so key zn_...abcd may still work. Revoke it at ' + dash + '.');
  assert.equal(m.revokeNotReached('EXAMPLE_VAR is set, so this was refused.', 'zn_...abcd', dash, QUIET),
    'EXAMPLE_VAR is set, so this was refused. Key zn_...abcd was not revoked. Revoke it at ' + dash + '.');
  assert.ok(m.revokeNotReached('ETIMEDOUT', 'k', dash, VERBOSE).endsWith(' Detail: ETIMEDOUT.'));
  assert.match(m.revokeNotReached('', 'k', dash, QUIET), /^Could not reach usezn\.com/);
});

test('connectNoStore gives the unlock command as the next step', () => {
  const text = m.connectNoStore('zn unlock --backend passphrase');
  assert.ok(text.includes('never in a plain file'));
  assert.ok(text.includes('nothing was saved.\nNext step: run `zn unlock --backend passphrase` (it asks you for a passphrase), then run `zn-gate connect` again.'));
});

test('disconnect messages', () => {
  assert.equal(m.DISCONNECT_UNLOCK_FIRST('zn unlock'),
    'Could not read the saved key from the zn vault, so nothing was removed or revoked. Run `zn unlock` and try again.');
  assert.equal(m.disconnectVaultNotRemoved('disk full.  ', 'zn unlock', 'zn-gate disconnect'),
    'Could not remove the saved key from the zn vault: disk full. Unlock the vault with `zn unlock`. Then run `zn-gate disconnect` again.');
  assert.equal(m.disconnectVaultNotRemoved('the vault is locked; unlock it first', 'zn unlock', 'zn-gate disconnect'),
    'Could not remove the saved key from the zn vault: the vault is locked; unlock it first. Then run `zn-gate disconnect` again.');
  assert.match(m.disconnectVaultNotRemoved(undefined, 'zn unlock', 'zn-gate disconnect'), /vault: unknown error\. Unlock the vault/);
});

test('vaultDamaged names the file, the reset command and the troubleshooting page', () => {
  const file = path.join(os.tmpdir(), 'example-project', 'vault.json');
  const text = m.vaultDamaged(file, 'is not valid JSON', 'fake parse error', QUIET);
  assert.ok(text.startsWith('Your vault file ' + file + ' is not valid JSON. zn did not change it and will not start a new vault over it. '));
  assert.match(text, /Restore it from a backup\. With no backup, run `(zn|npx -y zn-gate@\S+) vault reset`: it sets the old vault aside and starts empty, so the secrets saved in it are lost\. More: https:\/\/usezn\.com\/docs\/zn-gate\/troubleshooting\/$/);
  assert.ok(!text.includes('fake parse error'));
  const verbose = m.vaultDamaged(file, 'is not valid JSON', 'x'.repeat(200), VERBOSE);
  assert.ok(verbose.endsWith(' Detail: ' + 'x'.repeat(120) + '.'));
});

test('no message contains an absolute home path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-messages-home-'));
  try {
    const dash = 'https://dashboard.example.com';
    const outputs = [
      m.agentNote('CLAUDECODE'), m.agentNote('started from claude'), m.agentRefusal('zn unlock', 'CLAUDECODE'),
      m.notInteractive('zn unlock'), m.PROMPT_CANCELLED, m.CLIPBOARD_NO_POWERSHELL,
      m.clipboardUnreadable(['xclip', 'xsel']), m.invalidDuration('5x'), m.DURATION_RANGE,
      m.unknownBackend('foo', ['macos', 'passphrase']), m.unlockNeedsTerminal(), m.FOREGROUND_NEEDS_TERMINAL,
      m.PASSPHRASE_NEEDS_TERMINAL, m.passphraseCancelled(), m.passphraseMismatch(), m.forgetLockFirst(),
      m.vaultAlreadyUnlocked(), m.secretToolMissing(), m.powershellMissing(),
      m.keychainHelperFailed('fake detail', VERBOSE), m.keychainLostKey('macos', VERBOSE),
      m.vaultStartTimeout(), m.vaultStartExited(1, VERBOSE), m.vaultNotAnswering('fake detail', VERBOSE),
      m.auditFailed(7, 'fake error', VERBOSE), m.vaultLockedBecause('idle', 5), m.vaultLockedBecause('expired'),
      m.vaultLockedBecause('manual'), m.CONNECT_KEY_ON_COMMAND_LINE, m.CONNECT_CANCELLED, m.CONNECT_NOT_A_KEY,
      m.CONNECT_REJECTED, m.connectFullAccess('https://example.com/connect'),
      m.connectUnverified('ENOTFOUND', VERBOSE), m.connectUnverified('HTTP 500', VERBOSE),
      m.revokeNotReached('ENOTFOUND', 'zn_...abcd', dash, VERBOSE), m.revokeNotReached('HTTP 500', 'zn_...abcd', dash, VERBOSE),
      m.connectNoStore('zn unlock'), m.environmentRefusal('EXAMPLE_KEY', 'a reason', true),
      m.environmentRefusal('EXAMPLE_KEY', 'a reason', false), m.connectSaveFailed('disk full'),
      m.DISCONNECT_UNLOCK_FIRST('zn unlock'), m.disconnectVaultNotRemoved('disk full', 'zn unlock', 'zn-gate disconnect'),
      m.disconnectKeychainLeft('locked', dash, true), m.disconnectKeychainLeft('locked', dash, false),
      m.PINS_USAGE_APPROVE, m.pinsAgentRefusal('CLAUDECODE'), m.PINS_NEEDS_TERMINAL, m.PINS_NOT_APPROVED,
      m.pinsError('unknown server'), m.TEAM_INVALID_JOIN_TOKEN, m.TEAM_INVALID_REQUEST, m.TEAM_NOTHING_TO_APPROVE,
      m.TEAM_NOT_ASKED, m.TEAM_INVALID_ORG_KEY, m.teamJoinFailed('HTTP 403'),
      m.vaultDamaged('vault.json', 'is damaged', 'fake detail', VERBOSE),
      ...['macos', 'windows', 'libsecret', 'other'].flatMap((b) => [
        m.keychainProblem(b, 'save', { env: VERBOSE, detail: 'fake detail' }),
        m.keychainProblem(b, 'read', { slotIsVault: false, env: VERBOSE, detail: 'fake detail' }),
      ]),
    ];
    for (const text of outputs) {
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0);
      assert.ok(!text.includes(home), text);
      assert.ok(!text.includes(os.homedir()) || os.homedir() === path.sep, text);
      assert.ok(!/(^|[\s"'`(])(\/home\/|\/Users\/|[A-Za-z]:\\Users\\|~\/)/.test(text), text);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
