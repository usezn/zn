'use strict';

// A folder given to tar, zip, 7z, cp, rsync or scp that is too large to look through (3,000 entries, 6 levels or one
// second) is not allowed silently: the caller is told to ask the user. ~/.gnupg is a protected folder like ~/.ssh.
// Values are fake.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const policy = require('../lib/hooks/policy');

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-archlim-'));
  made.push(home);
  const proj = path.join(home, 'proj');
  put(path.join(proj, 'src', 'index.js'), '1\n');
  put(path.join(home, '.ssh', 'id_ed25519'), 'fake key\n');
  put(path.join(home, '.gnupg', 'private-keys-v1.d', 'ABCD0000.key'), 'fake key\n');
  put(path.join(home, '.gnupg', 'pubring.kbx'), 'fake\n');
  const big = path.join(proj, 'big');
  for (let i = 0; i < 40; i++) for (let j = 0; j < 100; j++) put(path.join(big, 'd' + i, 'f' + j + '.txt'), 'x');
  put(path.join(proj, 'deep', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'x.txt'), 'x');
  return { home, proj, opts: { home, cwd: proj, env: { HOME: home } } };
}

function run(cmd, opts) {
  const limitNotice = {};
  const deny = policy.bashDenial(cmd, { ...opts, limitNotice });
  return { deny, ask: limitNotice.hit || null };
}

test('a folder the look cannot finish asks instead of allowing', () => {
  const { opts } = fixture();
  const asked = [
    'tar czf big.tgz big',
    'zip -r big.zip big',
    'cp -r big /tmp/x',
    'rsync -a big/ host:/x',
    'tar czf d.tgz deep',
    'tar czf all.tgz .',
  ];
  for (const cmd of asked) {
    const r = run(cmd, opts);
    assert.equal(r.deny, null, `not refused: ${cmd}`);
    assert.match(r.ask || '', /too large for zn to look through/, `should ask: ${cmd}`);
  }
});

test('a small folder, or a command with no folder, does not ask', () => {
  const { opts } = fixture();
  for (const cmd of ['tar czf src.tgz src', 'cp -r src ./out', 'zip -r s.zip ./src', 'tar tzf k.tgz', 'ls big']) {
    const r = run(cmd, opts);
    assert.equal(r.deny, null, cmd);
    assert.equal(r.ask, null, `should not ask: ${cmd}`);
  }
});

test('a large folder does not hide a protected one named after it', () => {
  const { opts } = fixture();
  for (const cmd of ['tar czf k.tgz big ~/.ssh', 'cp -r big ~/.ssh /tmp/x', 'zip -r k.zip big ~/.gnupg']) {
    assert.ok(run(cmd, opts).deny, `should be refused: ${cmd}`);
  }
});

test('~/.gnupg is refused as a folder operand and as a file', () => {
  const { opts } = fixture();
  for (const cmd of ['tar czf k.tgz ~/.gnupg', 'cp -r ~/.gnupg x', 'zip -r a.zip ~/.gnupg', 'cat ~/.gnupg/pubring.kbx', 'tar czf k.tgz -C ~ .gnupg']) {
    assert.ok(run(cmd, opts).deny, `should be refused: ${cmd}`);
  }
  assert.equal(run('gpg --list-keys', opts).deny, null);
});
