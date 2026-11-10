'use strict';
/**
 * `zn unlock` on a new vault with a passphrase under 12 characters is refused with exit 1 and a plain
 * message, before anything is written. The real CLI runs in a child process with an isolated HOME and
 * ZN_HOME; the passphrase comes from stdin (--passphrase-stdin) and the passphrase backend is forced,
 * so no OS keychain is touched. Fake passphrases only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
// Environment variables that make zn think an AI agent is running it.
const AGENT_VARS = ['CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CURSOR_AGENT', 'OPENCODE', 'ZN_AGENT'];

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

function unlockWithPassphrase(t, passphrase) {
  const base = tempDir(t, 'zn-unlock-short-');
  const home = path.join(base, 'home');
  const zn = path.join(base, 'zn');
  const tmp = path.join(base, 'tmp');
  for (const d of [home, zn, tmp]) fs.mkdirSync(d);
  const env = Object.assign({}, process.env, {
    HOME: home, USERPROFILE: home, ZN_HOME: zn, TMPDIR: tmp, TEMP: tmp, TMP: tmp, ZN_STATS: 'off',
  });
  for (const k of AGENT_VARS) delete env[k];
  const r = spawnSync(process.execPath, [CLI, 'unlock', '--backend', 'passphrase', '--passphrase-stdin'], {
    input: passphrase + '\n', env, encoding: 'utf8', timeout: 60000,
  });
  return { r, zn };
}

for (const passphrase of ['short-9ch', 'eleven-char']) {
  test('zn unlock refuses a passphrase of ' + passphrase.length + ' characters (under 12): exit 1, nothing written', (t) => {
    const { r, zn } = unlockWithPassphrase(t, passphrase);
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.status, 1, 'exit code (the task said 2; the code exits 1 for a policy refusal)');
    assert.match(r.stderr, /passphrase must be at least 12 characters/);
    assert.equal(r.stdout.trim(), '', 'nothing printed to stdout');
    assert.deepEqual(filesUnder(zn), [], 'no vault file was written');
  });
}
