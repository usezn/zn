'use strict';
/*
 * Plain vault and connect messages for someone who ran zn-gate with npx:
 *  - every command that is suggested is the one that works on this computer (znCommand),
 *  - a usage mistake exits 2 and is never ignored,
 *  - keychain, vault and audit failures say what happened and one next step, with the code only under ZN_VERBOSE=1,
 *  - times are local, with the hours left.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');
const m = require('../lib/messages');
const { untilText } = require('../lib/vault/cli');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const NPX = /npx -y zn-gate@[0-9.]+/;

function zn(home, args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn') };
  delete env.ZN_VERBOSE;
  delete env.DEBUG;
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', input: '', timeout: 30000 });
}

/* ------------------------- usage mistakes exit 2 ------------------------- */

const USAGE_MISTAKES = [
  ['unlock', '--foo'],
  ['unlock', '--ttl'],
  ['unlock', '--ttl', '--idle', '1h'],
  ['unlock', '--backend'],
  ['unlock', 'extra'],
  ['unlock', '--ttl', 'abc'],
  ['unlock', '--ttl', '48h'],
  ['unlock', '--idle', '5x'],
  ['unlock', '--backend', 'nope'],
  ['lock', 'extra'],
  ['lock', '--now'],
  ['vault', 'status', '--x'],
  ['vault', 'status', 'extra'],
  ['vault', 'verify', 'x'],
  ['vault', 'reset', '--x'],
  ['vault', 'forget', 'a', 'b'],
  ['vault', 'forget', '--all'],
];

for (const args of USAGE_MISTAKES) {
  test('zn ' + args.join(' ') + ' exits 2 with a plain sentence, never ignored', (t) => {
    const home = tempDir(t, 'zn-usage-');
    const r = zn(home, args);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /^\[zn\] .+/m);
    assert.doesNotMatch(r.stderr, /ZN_[A-Z_]+|\n\s+at /, 'no code and no stack trace');
    assert.equal(r.stdout, '', 'nothing was done');
  });
}

test('an unknown option or a missing value shows the usage line of the command', (t) => {
  const home = tempDir(t, 'zn-usage-');
  const a = zn(home, ['unlock', '--foo']);
  assert.match(a.stderr, /Unknown option "--foo"\./);
  assert.match(a.stderr, /usage: .*unlock \[--ttl 8h\] \[--idle 30m\] \[--backend NAME\]/);
  const b = zn(home, ['unlock', '--ttl']);
  assert.match(b.stderr, /The option --ttl needs a value\./);
  const c = zn(home, ['lock', 'extra']);
  assert.match(c.stderr, /Unexpected argument "extra"\./);
  assert.match(c.stderr, /usage: .* lock\n$|usage: zn lock\n$/);
});

test('an invalid --ttl or --backend names the way to write it, exit 2 (as docs/cli.md says)', (t) => {
  const home = tempDir(t, 'zn-usage-');
  assert.match(zn(home, ['unlock', '--ttl', 'abc']).stderr, /invalid duration "abc" \(use e\.g\. 30m, 8h\)/);
  assert.match(zn(home, ['unlock', '--ttl', '48h']).stderr, /between 1m and 24h/);
  assert.match(zn(home, ['unlock', '--backend', 'nope']).stderr, /Unknown vault backend "nope"\. Use one of: macos, windows, libsecret, passphrase\./);
});

test('lock and vault status with correct arguments still exit 0', (t) => {
  const home = tempDir(t, 'zn-usage-');
  const lock = zn(home, ['lock']);
  assert.equal(lock.status, 0, lock.stderr);
  assert.match(lock.stdout, /Vault was not unlocked\./);
  const status = zn(home, ['vault', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Vault: not created yet \(run `(zn|npx -y zn-gate@[0-9.]+) unlock`\)\./);
});

/* ------------------- the command that works on this computer ------------------- */

const SENTENCES = [
  'm.passphraseCancelled()', 'm.passphraseMismatch()', 'm.forgetLockFirst()', 'm.vaultAlreadyUnlocked()', 'm.unlockNeedsTerminal()',
  "m.keychainProblem('macos', 'save')", "m.keychainProblem('windows', 'save')", "m.keychainProblem('libsecret', 'save')",
  'm.secretToolMissing()', 'm.powershellMissing()', "m.keychainHelperFailed('x')", 'm.vaultStartTimeout()', 'm.vaultStartExited(1)',
  "m.vaultNotAnswering('timeout')", "L('vault/reset').HINT", "L('vault/reset').NOTHING",
  "L('vault/reset').LOCK_FIRST", "L('vault/cli').OLD_VAULT_STUCK", "L('vault/cli').ALREADY_UNLOCKED",
  "m.connectNoStore(L('zn-command').znCommand('unlock'))",
];

function texts(pathValue) {
  const lib = path.join(__dirname, '..', 'lib');
  const script = 'const L = (n) => require(' + JSON.stringify(lib + path.sep) + ' + n); const m = L("messages");' +
    'process.stdout.write(JSON.stringify([' + SENTENCES.join(',') + ']));';
  const env = { PATH: pathValue, PATHEXT: '.CMD;.EXE', HOME: pathValue, ZN_HOME: path.join(pathValue, '.zn') };
  const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('without zn on PATH (the npx case) every suggested command is the npx form', { skip: process.platform === 'win32' }, (t) => {
  const empty = tempDir(t, 'zn-nopath-');
  const out = texts(empty);
  assert.equal(out.length, SENTENCES.length);
  for (const text of out) {
    assert.doesNotMatch(text, /`zn [a-z]|`zn`/, 'a command that does not exist here: ' + text);
  }
  assert.match(out[0], NPX);
  assert.match(out[3], NPX);
  assert.match(out[SENTENCES.length - 1], NPX);
});

test('with zn on PATH the short form is used', { skip: process.platform === 'win32' }, (t) => {
  const dir = tempDir(t, 'zn-onpath-');
  const bin = path.join(dir, 'zn');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  const out = texts(dir);
  for (const text of out.filter((x) => /unlock|lock|vault reset/.test(x))) assert.doesNotMatch(text, NPX, text);
  assert.match(out[0], /`zn unlock`/);
});

/* ------------------------------- local times ------------------------------- */

test('untilText: a local clock time with the time left, and "tomorrow" past midnight', () => {
  const now = new Date(2026, 9, 20, 10, 0, 0).getTime();
  assert.equal(untilText(new Date(2026, 9, 20, 18, 0, 0).toISOString(), now), '18:00 (in 8 h)');
  assert.equal(untilText(new Date(2026, 9, 20, 10, 40, 0).toISOString(), now), '10:40 (in 40 min)');
  assert.equal(untilText(new Date(2026, 9, 21, 2, 15, 0).toISOString(), now), 'tomorrow 02:15 (in 16 h)');
  assert.equal(untilText(new Date(2026, 9, 20, 10, 0, 20).toISOString(), now), '10:00 (in 1 min)');
  assert.equal(untilText('T', now), 'T', 'a value that is not a date is returned as it is');
  assert.doesNotMatch(untilText(new Date(2026, 9, 20, 18, 0, 0).toISOString(), now), /Z|T\d/, 'never the ISO form');
});

test('a vault that locked itself says why in words', () => {
  assert.equal(m.vaultLockedBecause('lock', 30), 'Vault locked.');
  assert.equal(m.vaultLockedBecause('idle', 30), 'Vault locked: it was not used for 30 min.');
  assert.equal(m.vaultLockedBecause('expired', 30), 'Vault locked: the time you set with --ttl ran out.');
});

/* ---------------- keychain, daemon, client and audit messages ---------------- */

test('a keychain failure names the platform and the next step; the code only with ZN_VERBOSE=1', () => {
  const mac = m.keychainProblem('macos', 'save', { detail: 'security exit 36', env: {} });
  assert.match(mac, /could not save the vault key in the macOS Keychain\. .*choose Allow.*Keychain Access/);
  assert.doesNotMatch(mac, /exit 36/);
  assert.match(m.keychainProblem('macos', 'save', { detail: 'security exit 36', env: { ZN_VERBOSE: '1' } }), / Detail: security exit 36\.$/);
  const win = m.keychainProblem('windows', 'read', { detail: 'exit 1', env: {} });
  assert.match(win, /could not read the vault key in the Windows Credential Manager\. Check that Credential Manager works/);
  assert.doesNotMatch(win, /passphrase/, 'a failed read does not suggest a passphrase for a vault that exists');
  const linux = m.keychainProblem('libsecret', 'save', { env: {} });
  assert.match(linux, /Linux keyring \(Secret Service\)\. Make sure your keyring is unlocked/);
  assert.match(linux, /unlock --backend passphrase/);
  const cloud = m.keychainProblem('libsecret', 'save', { slotIsVault: false, env: {} });
  assert.match(cloud, /could not save the zn-gate connect key/);
  assert.doesNotMatch(cloud, /passphrase/);
});

test('a missing keychain helper says what to install or what to use instead', () => {
  assert.match(m.secretToolMissing(), /libsecret-tools package \(for example: sudo apt install libsecret-tools\).*--backend passphrase/);
  assert.match(m.powershellMissing(), /could not find Windows PowerShell.*--backend passphrase/);
  const failed = m.keychainHelperFailed('/usr/bin/security (ENOENT)', {});
  assert.match(failed, /Close this terminal, open a new one and try again/);
  assert.doesNotMatch(failed, /ENOENT|\/usr\/bin/);
});

test('vault process problems say lock, then unlock, without internals', () => {
  assert.match(m.vaultNotAnswering('timeout', {}), /^The vault is not answering\. Run `[^`]+ lock`, then `[^`]+ unlock`\.$/);
  assert.match(m.vaultNotAnswering('ENOENT', { ZN_VERBOSE: '1' }), / Detail: ENOENT\.$/);
  const timeout = m.vaultStartTimeout();
  assert.doesNotMatch(timeout, /daemon/i);
  assert.match(timeout, /did not start in time\. Run `[^`]+ lock`, then `[^`]+ unlock` again\./);
  const exited = m.vaultStartExited(1, {});
  assert.doesNotMatch(exited, /daemon|\(1\)/i);
  assert.match(m.vaultStartExited(1, { ZN_VERBOSE: '1' }), /Detail: exit code 1\./);
});

test('a failed audit check says not to delete the log and where to read more', () => {
  const text = m.auditFailed(7, 'mac mismatch', {});
  assert.match(text, /did not pass its check \(at record 7\)\. Do not delete or edit it/);
  assert.match(text, /https:\/\/usezn\.com\/docs\/zn-gate\/troubleshooting\//);
  assert.doesNotMatch(text, /FAILED|mac mismatch/);
  assert.match(m.auditFailed(7, 'mac mismatch', { ZN_VERBOSE: '1' }), /Detail: mac mismatch\.$/);
});

/* ----------------------------- connect network text ----------------------------- */

test('connect and revoke network wording: plain sentence, one step, the code only with ZN_VERBOSE=1', () => {
  for (const code of ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'timed out', 'EAI_AGAIN', 'CERT_HAS_EXPIRED']) {
    const text = m.connectUnverified(code, {});
    assert.match(text, /^Could not reach usezn\.com, so the key was not checked and nothing was saved\. Check your internet connection/);
    assert.ok(!text.includes(code), code);
    assert.ok(m.connectUnverified(code, { ZN_VERBOSE: '1' }).includes('Detail: ' + code));
  }
  assert.match(m.connectUnverified('HTTP 502', {}), /^usezn\.com is not answering properly right now/);
  assert.doesNotMatch(m.connectUnverified('HTTP 502', {}), /502/);
  assert.match(m.revokeNotReached('ECONNRESET', 'zn_abc...', 'https://usezn.com/api-keys', {}), /^Could not reach usezn\.com, so key zn_abc\.\.\. was not revoked\./);
});

test('an environment refusal names the variable, says "the key" while connecting, and shows how to unset it per shell', () => {
  const connecting = require('../lib/cloud-key').tlsRefusal({ NODE_OPTIONS: '--require ./x.js' }, { saved: false });
  assert.match(connecting, /^NODE_OPTIONS is set in this terminal, so zn-gate will not send the key: /);
  assert.doesNotMatch(connecting, /saved key/);
  assert.match(connecting, /macOS or Linux: `unset NODE_OPTIONS`; Windows PowerShell: `Remove-Item Env:NODE_OPTIONS`\) and try again\.$/);
  const saved = require('../lib/cloud-key').tlsRefusal({ NODE_OPTIONS: '--require ./x.js' });
  assert.match(saved, /will not send the saved key/);
});
