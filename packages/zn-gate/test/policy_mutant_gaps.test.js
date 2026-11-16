'use strict';

// Decisions of lib/hooks/policy.js that a mutation audit showed no other test pins down: PowerShell
// parameters that come before -EncodedCommand, text a here-document only mentions, a word right at the
// length limit of the folder check, the work budget, and the shape of some small results.
// The .env file holds a made-up value; commands are ordinary reads and writes.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('../lib/hooks/policy');
const { tempDir } = require('./helpers/tmp');

function project(t) {
  const dir = tempDir(t, 'zn-pgaps-');
  fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello\n');
  return { cwd: dir, home: dir, env: {} };
}

const ENCODED_CAT_ENV = Buffer.from('cat .env', 'utf16le').toString('base64');

test('an encoded PowerShell command is read whatever parameters come before it', (t) => {
  const o = project(t);
  for (const lead of ['', '-NoProfile ', '-NoLogo ', '-ExecutionPolicy Bypass ']) {
    for (const shell of ['powershell', 'pwsh']) {
      for (const flag of ['-EncodedCommand', '-enc', '-e']) {
        const deny = policy.bashDenial(`${shell} ${lead}${flag} ${ENCODED_CAT_ENV}`, o);
        assert.match(deny || '', /plain-text secrets/, `${shell} ${lead}${flag}`);
      }
    }
  }
  assert.equal(policy.bashDenial('powershell -NoProfile -EncodedCommand ' + Buffer.from('echo hi', 'utf16le').toString('base64'), o), null);
});

test('a here-document that only mentions a .env file after an expansion is not a read of it', (t) => {
  const o = project(t);
  assert.equal(policy.bashDenial('cat <<EOF\n${USER} see .env here\nEOF', o), null);
  assert.equal(policy.bashDenial('cat <<EOF\n$HOME see .env here\nEOF', o), null);
  assert.equal(policy.bashDenial('cat <<EOF\n$(echo hi) see .env here\nEOF', o), null);
  assert.equal(policy.bashDenial('cat <<EOF\n$(cat notes.txt)\n.env\nEOF', o), null);
  // The command inside the expansion is still read.
  assert.match(policy.bashDenial('cat <<EOF\n$(cat .env)\nEOF', o) || '', /plain-text secrets/);
});

test('git -ArgumentList reads the revision path that follows it', (t) => {
  const o = project(t);
  assert.match(policy.bashDenial("git -ArgumentList 'show HEAD:.env'", o) || '', /reads \.env from the git repository/);
});

test('a word of exactly 4096 characters that holds .agents in a file name is checked like a shorter one', (t) => {
  const o = project(t);
  const word = 'a'.repeat(4096 - '.agents.txt'.length) + '.agents.txt';
  assert.equal(word.length, 4096);
  assert.equal(policy.bashDenial('touch ' + word, o), null);
});

test('a command that runs out of looks on disk is refused as too slow', (t) => {
  const o = project(t);
  const cmd = 'cat a.txt b.txt c.txt d.txt';
  const tight = { ...o, depth: 1, budget: { until: Date.now() + 600000, disk: 1 } };
  assert.match(policy.bashDenial(cmd, tight) || '', /too many paths for zn to check in time/);
  const roomy = { ...o, depth: 1, budget: { until: Date.now() + 600000, disk: 100000 } };
  assert.equal(policy.bashDenial(cmd, roomy), null);
  const late = { ...o, depth: 1, budget: { until: Date.now() - 1000, disk: 100000 } };
  assert.match(policy.bashDenial(cmd, late) || '', /too many paths for zn to check in time/);
});

test('a patch sent as a shell command names the file it writes, shortened past 120 characters', (t) => {
  const o = project(t);
  const patchFor = (file) => `apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: ${file}\n@@\n+EXAMPLE_DEBUG=1\n*** End Patch\nPATCH`;
  for (const [pad, long] of [[115, false], [116, true]]) {
    const dirName = 'd'.repeat(pad);
    fs.mkdirSync(path.join(o.cwd, dirName));
    fs.writeFileSync(path.join(o.cwd, dirName, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
    const file = dirName + '/.env';
    assert.equal(file.length, pad + 5);
    const msg = policy.bashDenial(patchFor(file), o) || '';
    if (long) {
      assert.ok(msg.includes('writes to ' + file.slice(0, 119) + '…,'), 'a 121-character name is cut');
    } else {
      assert.ok(msg.includes('writes to ' + file + ','), 'a 120-character name is shown whole');
    }
  }
});

test('wrapWithZnRun and wrapPowerShell leave a command without named markers as it is', () => {
  const a = policy.wrapWithZnRun('echo hi', 'zn run');
  assert.deepEqual(a, { ok: true, command: 'echo hi', wrapped: false });
  const b = policy.wrapPowerShell('echo hi', {});
  assert.equal(b.ok, true);
  assert.equal(b.command, 'echo hi');
  assert.equal(b.wrapped, false);
});

test('scanPowerShell marks a line as not simple when a double-quoted word expands a variable', () => {
  assert.equal(policy.scanPowerShell('Get-Content "$HOME/notes.txt"').simple, false);
  assert.equal(policy.scanPowerShell('Get-Content "a b"').simple, true);
});
