'use strict';
process.env.ZN_STATS = 'off';
// The wording of spaceMessage and unsafeDirMessage for paths that hold spaces: the text names the folder, gives the way out,
// and ends in a sentence, never in a bare error code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const launcher = require('../lib/agents/launcher');
const { tempDir } = require('./helpers/tmp');

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const skip = { skip: process.platform === 'win32' };
// No candidate folder exists, so the text does not depend on this machine.
const noFs = {
  lstatSync() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  realpathSync() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  statSync() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  accessSync() { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
};
const OPTS = { fs: noFs, env: {}, user: 'ana' };
const refusal = (fn) => { try { fn(); } catch (e) { return e.message; } assert.fail('expected a refusal'); };
const endsInSentence = (msg) => {
  assert.match(msg, /[.)`]$/);
  assert.doesNotMatch(msg, /\b(E[A-Z]{3,}|exit code \d+|code \d+)\s*$/);
  assert.doesNotMatch(msg, /\bE(ACCES|NOENT|PERM|EXIST|NOTDIR|LOOP)\b/);
};

test('spaceMessage: names the launcher path that holds spaces, and gives the command to run', () => {
  const file = '/home/ana/My Projects/.zn/hooks/antigravity pre.sh';
  const msg = launcher.spaceMessage(file, OPTS);
  assert.ok(msg.includes('the launcher would be at ' + file + ','));
  assert.match(msg, /Choose a folder outside the home folder whose path has only letters, digits and - _ \. \//);
  assert.match(msg, /`ZN_HOOK_DIR=<that folder> zn hooks install antigravity`/);
  assert.match(msg, /Choose any folder that meets these rules\./);
  endsInSentence(msg);
});

test('spaceMessage: the same text comes back for the same path, and without options', () => {
  const file = '/srv/my data/x.sh';
  assert.equal(launcher.spaceMessage(file, OPTS), launcher.spaceMessage(file, OPTS));
  const msg = launcher.spaceMessage(file);
  assert.ok(msg.includes(file));
  endsInSentence(msg);
});

test('unsafeDirMessage: names a folder with spaces, its reason and the way out', () => {
  const dir = '/home/ana/my hooks/zn';
  const msg = launcher.unsafeDirMessage(dir, 'it is a link', 'Use the folder it leads to instead.', OPTS);
  assert.ok(msg.startsWith('zn will not keep its hook launcher in ' + dir + ': it is a link. '));
  assert.match(msg, /Use the folder it leads to instead\. Use a folder that you own/);
  assert.match(msg, /Or unset ZN_HOOK_DIR to use ~\/\.zn\/hooks\.$/);
  endsInSentence(msg);
});

test('unsafeDirMessage: without a fix step the text goes straight to the rules', () => {
  const msg = launcher.unsafeDirMessage('/a b/c', 'it is not a folder', undefined, OPTS);
  assert.match(msg, /it is not a folder\. The launcher runs on every tool call, so anyone who can replace it could run commands as you\. Use a folder that you own/);
  assert.doesNotMatch(msg, /undefined/);
  endsInSentence(msg);
});

test('unsafeDirMessage: a missing parent folder with spaces is a sentence, not a raw error code', skip, (t) => {
  const base = tempDir(t, 'zn ldw-');
  const dir = path.join(base, 'no such', 'hooks dir');
  fs.writeFileSync(path.join(base, 'no such'), 'x');
  const msg = refusal(() => launcher.ensureSafeHookDir(dir, 'linux', { trustedRoot: TMP_ROOT }));
  assert.ok(msg.includes('zn will not keep its hook launcher in '));
  assert.ok(msg.includes('no such'));
  assert.match(msg, /Or unset ZN_HOOK_DIR to use ~\/\.zn\/hooks\.$/);
  endsInSentence(msg);
});

test('unsafeDirMessage: a link named with spaces is named in the refusal, with the way out', skip, (t) => {
  const base = tempDir(t, 'zn ldw-');
  const real = path.join(base, 'real folder');
  fs.mkdirSync(real, { mode: 0o700 });
  const link = path.join(base, 'a link');
  fs.symlinkSync(real, link);
  const msg = refusal(() => launcher.ensureSafeHookDir(link, 'linux', { trustedRoot: TMP_ROOT }));
  assert.ok(msg.includes(link + ': it is a link.'));
  assert.match(msg, /Or unset ZN_HOOK_DIR to use ~\/\.zn\/hooks\.$/);
  endsInSentence(msg);
});
