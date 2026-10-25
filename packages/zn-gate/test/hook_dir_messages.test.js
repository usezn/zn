'use strict';
process.env.ZN_STATS = 'off';
// The messages for a refused ZN_HOOK_DIR: they name the folder that fails and why, turn a raw file system error into a
// sentence, give a fix that fits who owns the folder, and suggest only folders that pass the same rules on this machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const launcher = require('../lib/agents/launcher');
const { tempDir } = require('./helpers/tmp');

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const skip = { skip: process.platform === 'win32' };
const mkdirMode = (dir, mode) => { fs.mkdirSync(dir, { recursive: true }); fs.chmodSync(dir, mode); return dir; };
const refusal = (fn) => { try { fn(); } catch (e) { return e.message; } assert.fail('expected a refusal'); };

// A small fake of the fs functions the suggestions use: `real` maps a path to its real path; `dirs` are the folders that exist.
function fakeFs({ dirs, links = {}, writable = [] }) {
  const exists = (p) => dirs.includes(p) || p in links;
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    lstatSync(p) { if (!exists(p)) throw enoent(); return { isSymbolicLink: () => p in links }; },
    realpathSync(p) { if (p in links) return links[p]; if (!exists(p)) throw enoent(); return p; },
    statSync(p) { if (!exists(p)) throw enoent(); return { isDirectory: () => true }; },
    accessSync(p) { if (!writable.includes(p)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
  };
}

test('suggestions: /opt that is a link (Fedora Silverblue) is not suggested, /var/opt is, and the message says why', () => {
  const fsx = fakeFs({ dirs: ['/', '/var', '/var/opt', '/usr', '/usr/local'], links: { '/opt': '/var/opt' } });
  const list = launcher.hookDirSuggestions({ fs: fsx, env: {}, user: 'ana' });
  assert.deepEqual(list.map((x) => x.dir), ['/var/opt/ana-zn-hooks', '/usr/local/ana-zn-hooks']);
  assert.match(list[0].command, /^sudo mkdir -m 700 \/var\/opt\/ana-zn-hooks && sudo chown ana /);
  const msg = launcher.spaceMessage('/home/a b/.zn/hooks/x.sh', { fs: fsx, env: {}, user: 'ana' });
  assert.match(msg, /\/opt is a link on this machine, to \/var\/opt/);
  assert.doesNotMatch(msg, /mkdir -m 700 \/opt\//);
});

test('suggestions: a plain /opt is suggested when it is a real folder', () => {
  const fsx = fakeFs({ dirs: ['/', '/opt'] });
  assert.equal(launcher.hookDirSuggestions({ fs: fsx, env: {}, user: 'ana' })[0].dir, '/opt/ana-zn-hooks');
});

test('suggestions: a link anywhere in the path of a candidate rules it out (checked on the nearest existing folder)', () => {
  const fsx = fakeFs({ dirs: ['/'], links: { '/opt': '/x', '/var': '/y', '/usr': '/z' } });
  assert.deepEqual(launcher.hookDirSuggestions({ fs: fsx, env: {}, user: 'ana' }), []);
  assert.match(launcher.spaceMessage('/x y/z', { fs: fsx, env: {}, user: 'ana' }), /Choose any folder that meets these rules/);
});

test('suggestions: XDG_DATA_HOME comes first when it is set and has no space, and needs no sudo when it is writable', () => {
  const fsx = fakeFs({ dirs: ['/', '/home', '/home/ana', '/home/ana/data', '/opt'], writable: ['/home/ana/data'] });
  const list = launcher.hookDirSuggestions({ fs: fsx, env: { XDG_DATA_HOME: '/home/ana/data' }, user: 'ana' });
  assert.equal(list[0].dir, '/home/ana/data/zn-hooks');
  assert.equal(list[0].command, 'mkdir -p -m 700 /home/ana/data/zn-hooks');
  assert.equal(list[1].dir, '/opt/ana-zn-hooks');
});

test('suggestions: XDG_DATA_HOME that needs sudo also gives the folder to you, so the check accepts it', () => {
  const fsx = fakeFs({ dirs: ['/', '/srv', '/srv/data'] });
  const list = launcher.hookDirSuggestions({ fs: fsx, env: { XDG_DATA_HOME: '/srv/data' }, user: 'ana' });
  assert.equal(list[0].command, 'sudo mkdir -p -m 700 /srv/data/zn-hooks && sudo chown ana /srv/data/zn-hooks');
});

test('suggestions: the state the sudo command leaves (leaf yours, mode 700) passes the check', skip, (t) => {
  const dir = mkdirMode(path.join(tempDir(t, 'zn-hdm-'), 'zn-hooks'), 0o700);
  assert.doesNotThrow(() => launcher.ensureSafeHookDir(dir, 'linux', { trustedRoot: TMP_ROOT }));
});

test('suggestions: XDG_DATA_HOME with a space, or a relative one, is ignored', () => {
  const fsx = fakeFs({ dirs: ['/', '/home', '/home/a b', '/home/a b/data', '/opt'] });
  for (const xdg of ['/home/a b/data', 'data/rel']) {
    const list = launcher.hookDirSuggestions({ fs: fsx, env: { XDG_DATA_HOME: xdg }, user: 'ana' });
    assert.equal(list[0].dir, '/opt/ana-zn-hooks', xdg);
  }
});

test('suggestions: a user name with odd characters falls back to <you>', () => {
  const fsx = fakeFs({ dirs: ['/', '/opt'] });
  assert.equal(launcher.hookDirSuggestions({ fs: fsx, env: {}, user: 'DOMAIN\\ana smith' })[0].dir, '/opt/<you>-zn-hooks');
});

test('refusal: a folder above that your own account owns and others can write names that folder and a chmod without sudo', skip, (t) => {
  const open = mkdirMode(path.join(tempDir(t, 'zn-hdm-'), 'open'), 0o775);
  const dir = path.join(open, 'x', 'hooks');
  const msg = refusal(() => launcher.ensureSafeHookDir(dir, 'linux', { trustedRoot: TMP_ROOT }));
  assert.ok(msg.includes('zn will not keep its hook launcher in ' + dir + ': the folder above it, ' + open + ', can be written by other users (mode 775)'), msg);
  assert.ok(msg.includes('`chmod g-w,o-w ' + open + '`'), msg);
  assert.doesNotMatch(msg, /sudo chmod/);
  assert.equal(fs.existsSync(path.join(open, 'x')), false);
});

test('refusal: the folder itself open to others gets the same sudo-free chmod', skip, (t) => {
  const dir = mkdirMode(path.join(tempDir(t, 'zn-hdm-'), 'hooks'), 0o777);
  const msg = refusal(() => launcher.ensureSafeHookDir(dir, 'linux', { trustedRoot: TMP_ROOT }));
  assert.match(msg, /other users can write to it \(mode 777\)/);
  assert.ok(msg.includes('`chmod g-w,o-w ' + dir + '`'), msg);
});

test('refusal: a shared (sticky) folder you own gets the shared-folder notice, not a chmod', skip, (t) => {
  const shared = mkdirMode(path.join(tempDir(t, 'zn-hdm-'), 'shared'), 0o1777);
  const msg = refusal(() => launcher.ensureSafeHookDir(path.join(shared, 'hooks'), 'linux', { trustedRoot: TMP_ROOT }));
  assert.match(msg, /shared folder \(sticky bit\)/);
  assert.doesNotMatch(msg, /`chmod g-w,o-w/);
});

test('refusal: a path with a space is quoted in the chmod advice', skip, (t) => {
  const open = mkdirMode(path.join(tempDir(t, 'zn-hdm-'), 'my open'), 0o775);
  const msg = refusal(() => launcher.ensureSafeHookDir(path.join(open, 'h'), 'linux', { trustedRoot: TMP_ROOT }));
  assert.ok(msg.includes("`chmod g-w,o-w '" + open + "'`"), msg);
});

test('writableFix: sudo only for a root-owned folder, never for a shared (sticky) or foreign one', () => {
  const fix = launcher.writableFix;
  assert.equal(fix('/home/ana', { uid: 1000, mode: 0o40775 }, 1000), 'To close it, run `chmod g-w,o-w /home/ana`.');
  assert.match(fix('/srv/data', { uid: 0, mode: 0o40775 }, 1000), /belongs to root.*`sudo chmod g-w,o-w \/srv\/data`/);
  assert.match(fix('/tmp', { uid: 1000, mode: 0o41777 }, 1000), /shared folder/);
  assert.doesNotMatch(fix('/tmp', { uid: 1000, mode: 0o41777 }, 1000), /chmod/);
  assert.doesNotMatch(fix('/tmp', { uid: 0, mode: 0o41777 }, 1000), /chmod/);
  assert.match(fix('/tmp', { uid: 0, mode: 0o41777 }, 1000), /shared folder/);
  assert.doesNotMatch(fix('/srv/x', { uid: 2000, mode: 0o40777 }, 1000), /sudo/);
  assert.match(fix('/srv/x', { uid: 2000, mode: 0o40777 }, 1000), /belongs to another user/);
});

test('refusal: a link in the path names the link and where it leads, and points at the real folder', skip, (t) => {
  const root = tempDir(t, 'zn-hdm-');
  const safe = mkdirMode(path.join(root, 'safe'), 0o700);
  const own = mkdirMode(path.join(root, 'own'), 0o700);
  fs.symlinkSync(safe, path.join(own, 'lnk'));
  const dir = path.join(own, 'lnk', 'hooks');
  const msg = refusal(() => launcher.ensureSafeHookDir(dir, 'linux', { trustedRoot: TMP_ROOT }));
  assert.ok(msg.includes('the path goes through a link: ' + path.join(own, 'lnk') + ' leads to ' + safe), msg);
});

test('refusal: a raw ENOENT or EACCES from the file system becomes a sentence that names the path', skip, (t) => {
  assert.equal(launcher.describeFsError({ code: 'ENOENT' }, '/a/b'), 'the folder /a/b does not exist (or it was removed while zn was checking it)');
  assert.match(launcher.describeFsError({ code: 'EACCES' }, '/a/b'), /you are not allowed to read or create \/a\/b/);
  assert.match(launcher.describeFsError({ code: 'ENOTDIR' }, '/a/b'), /\/a\/b is a file, not a folder/);
  assert.match(launcher.describeFsError({ code: 'EROFS' }, '/a/b'), /read-only disk/);
  assert.match(launcher.describeFsError({ code: 'EWHATEVER' }, '/a/b'), /refused to use \/a\/b \(EWHATEVER\)/);

  // The folder disappears between the existence test and the real-path check.
  const dir = mkdirMode(path.join(tempDir(t, 'zn-hdm-'), 'hooks'), 0o700);
  const orig = fs.realpathSync;
  fs.realpathSync = (p, ...a) => { if (p === dir) throw Object.assign(new Error("ENOENT: no such file or directory, lstat '" + p + "'"), { code: 'ENOENT', path: p }); return orig(p, ...a); };
  let msg;
  try { msg = refusal(() => launcher.ensureSafeHookDir(dir, 'linux', { trustedRoot: TMP_ROOT })); } finally { fs.realpathSync = orig; }
  assert.ok(msg.includes('the folder ' + dir + ' does not exist'), msg);
  assert.doesNotMatch(msg, /ENOENT|lstat/);
  assert.match(msg, /Create the folder or choose another one/);
});

test('refusal: a parent that cannot be written gives a plain message instead of a raw EACCES', skip, (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root can write anywhere
  const parent = mkdirMode(path.join(tempDir(t, 'zn-hdm-'), 'ro'), 0o500);
  const dir = path.join(parent, 'hooks');
  const msg = refusal(() => launcher.ensureSafeHookDir(dir, 'linux', { trustedRoot: TMP_ROOT }));
  assert.ok(msg.includes('you are not allowed to read or create ' + dir), msg);
  assert.doesNotMatch(msg, /EACCES|mkdir '/);
  fs.chmodSync(parent, 0o700);
});
