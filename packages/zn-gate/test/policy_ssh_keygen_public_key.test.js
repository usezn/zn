'use strict';

// The shell policy allows `ssh-keygen -l` on a public key (it only prints the fingerprint) and still
// stops a plain read of a private key. Static check only: the commands are analysed, never run.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('../lib/hooks/policy');
const { tempDir } = require('./helpers/tmp');

// A home folder with an ed25519 key pair. The key material is fake.
function keyHome(t) {
  const home = tempDir(t, 'zn-keygen-home-');
  const dir = path.join(home, 'work', 'app');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nZnTestFakeKeyMaterial\n-----END OPENSSH PRIVATE KEY-----\n');
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAAC3ZnTestFakeKeyMaterial zn-test@example.invalid\n');
  return { home, dir };
}

test('ssh-keygen -l on a public key is allowed, and cat of a private key is still denied', (t) => {
  const { home, dir } = keyHome(t);
  const opts = { cwd: dir, home };

  assert.equal(policy.bashDenial('ssh-keygen -l -f ~/.ssh/id_ed25519.pub', opts), null);
  assert.equal(policy.bashDenial('ssh-keygen -lf ~/.ssh/id_ed25519.pub', opts), null);

  const denied = policy.bashDenial('cat ~/.ssh/id_ed25519', opts);
  assert.match(denied || '', /treats it as holding secrets \(SSH private key\)/);
});
