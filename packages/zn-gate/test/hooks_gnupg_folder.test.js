'use strict';

// The GnuPG home folder itself is protected like the files in it: archiving, copying or searching the whole folder
// reads every private key. The gpg programs using their own home folder stay allowed. Values are fake.

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

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-gnupg-dir-'));
  made.push(home);
  fs.mkdirSync(path.join(home, '.gnupg', 'private-keys-v1.d'), { recursive: true });
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming', 'gnupg'), { recursive: true });
  fs.mkdirSync(path.join(home, 'proj'), { recursive: true });
  return { home, opts: { home, cwd: path.join(home, 'proj'), env: { HOME: home } } };
}

test('naming the GnuPG folder in a reading, copying or archiving command is refused', () => {
  const { home, opts } = fixture();
  const cmds = [
    'tar czf out.tgz ~/.gnupg',
    'tar czf out.tgz ~/.gnupg/',
    'tar czf out.tgz $HOME/.gnupg',
    'tar czf out.tgz ${HOME}/.gnupg/',
    'cp -r ~/.gnupg backup',
    'cp -r ~/.gnupg/ backup/',
    'grep -r BEGIN ~/.gnupg',
    'zip -r out.zip ~/.gnupg',
    'rsync -a ~/.gnupg/ backup/',
    'cp -r ~/AppData/Roaming/gnupg backup',
    'cp -r $HOME/AppData/Roaming/gnupg/ backup',
    'cp -r %APPDATA%/gnupg backup',
    'cp -r %APPDATA%\\gnupg backup',
    'cp -r $env:APPDATA\\gnupg backup',
    'tar czf out.tgz ' + path.join(home, '.gnupg'),
    'cd ~/.gnupg',
    'ls ~/.gnupg',
  ];
  for (const c of cmds) assert.ok(policy.bashDenial(c, opts), 'should be refused: ' + c);
});

test('the GnuPG folder is refused as a path to read', () => {
  const { home, opts } = fixture();
  for (const p of ['~/.gnupg', '~/.gnupg/', path.join(home, '.gnupg'), '$HOME/.gnupg', '~/AppData/Roaming/gnupg', '%APPDATA%\\gnupg']) {
    assert.ok(policy.readDenial(p, opts), 'read should be refused: ' + p);
  }
});

test('the gpg programs using their own home folder stay allowed', () => {
  const { opts } = fixture();
  const allowed = [
    'gpg --homedir ~/.gnupg --list-keys',
    'gpg --homedir ~/.gnupg/ --list-secret-keys',
    'gpg2 --homedir $HOME/.gnupg --armor --export user@example.com',
    'gpgconf --homedir ~/.gnupg --list-dirs',
    'gpg --list-keys',
    'echo gnupg',
    'tar czf out.tgz src',
  ];
  for (const c of allowed) assert.equal(policy.bashDenial(c, opts), null, 'should be allowed: ' + c);
});
