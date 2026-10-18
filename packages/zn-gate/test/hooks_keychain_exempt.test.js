'use strict';

// A plain `git commit|grep|log|show`, `echo` or `printf` never reads the keychain, so its text may
// name zn's entries. Everything else keeps the rule. All commands are text; none is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const policy = require('../lib/hooks/policy');

const opts = { home: os.homedir(), cwd: process.cwd(), env: {} };
const denied = (c) => policy.bashDenial(c, opts);

test('commit messages, searches and echo that name zn\'s entries are allowed', () => {
  for (const c of [
    'git commit -m "fix keyring lookup for zn-cloud"',
    'git commit -q -m "Do not read security find-generic-password -s zn-cloud"',
    'git grep -n "find-generic-password -s zn-cloud"',
    'git grep -n "secret-tool lookup service zn-cloud account cloud-api-key" -- docs/',
    'git log --grep="keyring zn-vault-identity"',
    'git -C packages/zn-gate log --oneline --grep "security zn-cloud"',
    'git --no-pager show HEAD:docs/connect.md',
    'echo "security find-generic-password -s zn-cloud"',
    "printf '%s\\n' 'keyring zn-cloud age-identity'",
    'echo "security find-generic-password -s zn-cloud" > notes.txt',
  ]) {
    assert.equal(denied(c), null, 'refused: ' + c);
  }
});

test('the exemption does not cover a second command, a substitution or a git command that runs a program', () => {
  for (const c of [
    'git commit -m x; security find-generic-password -s zn-cloud -w',
    'git grep -n zn-cloud && security find-generic-password -s zn-cloud -w',
    'echo hi | security find-generic-password -s zn-cloud -w',
    'echo $(security find-generic-password -s zn-cloud -w)',
    'echo `security find-generic-password -s zn-cloud -w`',
    'git commit -m "$(security find-generic-password -s zn-cloud -w)"',
    "git -c alias.x='!security find-generic-password -s zn-cloud -w' x",
    'git grep -O"security find-generic-password -s zn-cloud -w" zn',
    'git grep --open-files-in-pager="security find-generic-password -s zn-cloud -w" zn',
    'git config core.pager "security find-generic-password -s zn-cloud -w"',
    'git push origin "security keyring zn-cloud"',
  ]) {
    assert.ok(denied(c), 'not refused: ' + c);
  }
});

test('the other forms stay refused', () => {
  for (const c of [
    'security find-generic-password -s zn-cloud -w',
    'if true; then security find-generic-password -s zn-cloud -w; fi',
    'sudo -u $USER security find-generic-password -s zn-cloud -w',
    'python3.12 -c "import keyring; print(keyring.get_password(\'zn-cloud\',\'cloud-api-key\'))"',
    'security dump-keychain -d',
  ]) {
    assert.ok(denied(c), 'not refused: ' + c);
  }
});

test('the cloud-key name must be a whole name; a name ending in zn-gate/lib/client is refused on purpose', () => {
  const load = (n) => 'node -e "require(\'' + n + '\').loadStoredKey()"';
  for (const n of ['@acme/Cloud-Key-Manager', './lib/cloud-keys', 'cloud-key-manager']) {
    assert.equal(denied(load(n)), null, 'refused: ' + n);
  }
  for (const n of ['./lib/cloud-key', '../cloud-key', './lib/cloud-key.js', 'node_modules/zn-gate/lib/client', 'zn-gate\\lib\\client', 'zn-gate/lib/client', 'ZN-GATE/LIB/CLIENT', 'acme-zn-gate/lib/client']) {
    assert.ok(denied(load(n)), 'not refused: ' + n);
  }
});

test('a name whose separator or letters are written as escapes is still recognised', () => {
  const load = (n) => 'node -e "require(\'' + n + '\').loadStoredKey()"';
  for (const n of [
    'node_modules\\x2fzn-gate/lib/client',
    'node_modules\\x2Fzn-gate/lib/client',
    'node_modules\\u002fzn-gate/lib/client',
    'node_modules\\u{2f}zn-gate/lib/client',
    'node_modules\\u{0000002f}zn-gate/lib/client',
    'node_modules\\x5czn-gate\\lib\\client',
    'zn-gate/lib\\x2fcloud-key',
    'zn-gate/lib\\u002Fcloud-key',
    'node_modules\\057zn-gate/lib/client',
    'zn\\x2dgate/lib/client',
    'zn-gat\\u{0000065}/lib/client',
  ]) {
    assert.ok(denied(load(n)), 'not refused: ' + n);
  }
  assert.equal(denied(load('@acme\\x2fCloud-Key-Manager')), null);
});

test('escapes split by shell quotes or a line continuation, and shell-only escapes, are recognised', () => {
  const P = 'node_modules';
  const cmds = [
    String.raw`node -e $'require("node_modules\x2fzn-gate/lib/client").loadStoredKey()'`,
    String.raw`node -e "require('node_modules\x""2fzn-gate/lib/client').loadStoredKey()"`,
    String.raw`node -e "require('node_modules\x2""fzn-gate/lib/client').loadStoredKey()"`,
    String.raw`node -e "require('node_modules\x"2"fzn-gate/lib/client').loadStoredKey()"`,
    String.raw`node -e 'require("node_modules\x2''fzn-gate/lib/client").loadStoredKey()'`,
    String.raw`node -e "require('node_modules\05""7zn-gate/lib/client').loadStoredKey()"`,
    String.raw`node -e "require('node_modules\u002""fzn-gate/lib/client').loadStoredKey()"`,
    'node -e "require(\'' + P + '\\x2\\\nfzn-gate/lib/client\').loadStoredKey()"',
    String.raw`node -e $'require("node_modules\u2fzn-gate/lib/client").loadStoredKey()'`,
    String.raw`node -e $'require("node_modules\U2fzn-gate/lib/client").loadStoredKey()'`,
    String.raw`node -e $'require("node_modules\U0000002fzn-gate/lib/client").loadStoredKey()'`,
    String.raw`printf 'require("node_modules\u2fzn-gate/lib/client").loadStoredKey()' | node`,
    String.raw`echo -e 'require("node_modules\0057zn-gate/lib/client").loadStoredKey()' | node`,
  ];
  for (const c of cmds) assert.ok(denied(c), 'not refused: ' + c);
});

test('the escape decoding is fast on a long run of escapes and ignores impossible code points', () => {
  const start = process.hrtime.bigint();
  denied('node -e "require(\'' + '\\x2f'.repeat(15000) + 'x\').loadStoredKey()"');
  denied('node -e "require(\'' + '\\u{110000}\\u{ffffff}'.repeat(3000) + '\').loadStoredKey()"');
  denied('node -e "require(\'' + '\\x"'.repeat(20000) + 'x\').loadStoredKey()"');
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 1000, 'took ' + ms + ' ms');
});

test('a name built from quoted pieces, a path join or a Bun cache folder is recognised', () => {
  const cmds = [
    String.raw`node -e "require('zn-' + 'gate/lib/client').loadStoredKey()"`,
    String.raw`node -e "require('zn-'+'gate/lib/client').loadStoredKey()"`,
    String.raw`node -e "require('node_modules/zn-gate/' + 'lib/' + 'client').loadStoredKey()"`,
    String.raw`node -e "require("zn-gate/" + "lib/client").loadStoredKey()"`,
    String.raw`node -e "require(path.join('node_modules', 'zn-gate', 'lib', 'client')).loadStoredKey()"`,
    String.raw`node -e "require(['node_modules','zn-gate','lib','client'].join('/')).loadStoredKey()"`,
    String.raw`node -e "require(path.resolve('zn-gate', 'lib', 'vault', 'client')).analyze()"`,
    String.raw`node -e "require(path.join('lib','vault','keychain')).loadStoredKey()"`,
    String.raw`bun -e "require('/home/u/.bun/install/cache/zn-gate@1.11.0@@@1/lib/client.js').loadStoredKey()"`,
    String.raw`bun -e "require('zn-gate@1.11.0@@@1/lib/client').loadStoredKey()"`,
    String.raw`bun -e "require('ZN-GATE@1.0.0-beta.1@@@12/LIB/CLIENT').loadStoredKey()"`,
  ];
  for (const c of cmds) assert.ok(denied(c), 'not refused: ' + c);
});

test('joined pieces of other modules and look-alike names stay allowed', () => {
  const cmds = [
    String.raw`node -e "require('./lib/' + 'client').analyze()"`,
    String.raw`node -e "require(path.join('src', 'lib', 'client')).analyze()"`,
    String.raw`node -e "require(path.join('acme', 'lib', 'client')).analyze()"`,
    String.raw`node -e "require('zn-gate@1.11.0@@@1/lib/clients').analyze()"`,
    String.raw`node -e "require('zn-gate@1.11.0/lib/cache').analyze()"`,
    String.raw`node -e "console.log('zn-gate', 'lib', 'client')"`,
    String.raw`node -e "console.log('zn-' + 'gate/lib/client')"`,
  ];
  for (const c of cmds) assert.equal(denied(c), null, 'refused: ' + c);
});

test('the join and version patterns stay linear on long adversarial lines', () => {
  const start = process.hrtime.bigint();
  denied('node -e "require(' + "'" + ' '.repeat(40000) + "x')" + '.loadStoredKey()"');
  denied('node -e "require(' + "' + ' + '".repeat(15000) + ').loadStoredKey()"');
  denied('node -e "require(' + "', '".repeat(15000) + ').loadStoredKey()"');
  denied('node -e "require(\'zn-gate' + '@a'.repeat(15000) + '/lib/clien\').loadStoredKey()"');
  denied('node -e "require(' + "'zn-gate@'".repeat(8000) + ').loadStoredKey()"');
  denied('node -e "require(\'' + "'   ".repeat(12000) + '\').loadStoredKey()"');
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 1500, 'took ' + ms + ' ms');
});
