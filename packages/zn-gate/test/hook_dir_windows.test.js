'use strict';
process.env.ZN_STATS = 'off';
// ZN_HOOK_DIR on Windows: the folder holds the launcher that runs on every tool call, so it gets the same rule as on Unix,
// read from the owner and the access list (ACL) of every folder in the path, and no link or junction anywhere in it.
// Most tests run on every platform with a simulated ACL reader (the Windows branch is chosen with `platform: 'win32'`);
// the last ones use the real ACLs and only run on Windows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const launcher = require('../lib/agents/launcher');
const { tempDir } = require('./helpers/tmp');

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const ME = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1002';
const USERS = 'S-1-5-32-545';
const EVERYONE = 'S-1-1-0';
const SYSTEM = 'S-1-5-18';
const ADMINS = 'S-1-5-32-544';
const FULL = 0x1f01ff;
const MODIFY = 0x1301bf;
const READ = 0x1200a9;
const ADD_FILE = 0x2;
const DELETE_CHILD = 0x40;

const ace = (sid, rights, extra = {}) => ({ sid, rights, type: 'Allow', inheritOnly: false, ...extra });
const goodAces = () => [ace(ME, FULL), ace(SYSTEM, FULL), ace(ADMINS, FULL)];

/** A fake ACL reader: every folder is yours with a clean list, except where `over[path]` says otherwise. */
function fakeAcls(over = {}, calls = []) {
  return (paths) => {
    calls.push(paths.slice());
    if (over.__fail) throw new Error(over.__fail);
    return { user: ME, entries: paths.map((p) => ({ path: p, owner: ME, aces: goodAces(), ...(over[p] || {}) })) };
  };
}
const opts = (over, calls) => ({ trustedRoot: TMP_ROOT, readWinAcls: fakeAcls(over, calls), setWinPrivate: () => {} });
const win = (dir, o) => launcher.ensureSafeHookDir(dir, 'win32', o);

test('ZN_HOOK_DIR on Windows: a link in an ancestor is refused and nothing is created through it (Daybreak case)', (t) => {
  const root = tempDir(t, 'zn-whd-link-');
  const target = path.join(root, 'elsewhere');
  fs.mkdirSync(target);
  const link = path.join(root, 'link');
  fs.symlinkSync(target, link, 'junction');
  assert.throws(() => win(path.join(link, 'hooks'), opts()), /link or junction is in its path/);
  assert.deepEqual(fs.readdirSync(target), []);
  // the leaf itself being a link is refused too
  const leafLink = path.join(root, 'leaf');
  fs.symlinkSync(target, leafLink, 'junction');
  assert.throws(() => win(leafLink, opts()), /it is a link/);
});

test('ZN_HOOK_DIR on Windows: a good chain is accepted, a new folder is created and made private for you', (t) => {
  const root = tempDir(t, 'zn-whd-ok-');
  const calls = [];
  const priv = [];
  const o = { ...opts({}, calls), setWinPrivate: (d, sid) => priv.push([d, sid]) };
  const dir = path.join(root, 'a', 'hooks');
  win(dir, o);
  assert.ok(fs.statSync(dir).isDirectory());
  assert.deepEqual(priv, [[dir, ME]]);
  assert.ok(calls.length >= 2); // before creating and after making it private
  win(dir, opts()); // an existing good folder is accepted as it is
});

test('ZN_HOOK_DIR on Windows: other users who can write to the launcher folder are refused and nothing is written', (t) => {
  const root = tempDir(t, 'zn-whd-w-');
  const dir = path.join(root, 'hooks');
  fs.mkdirSync(dir);
  for (const sid of [USERS, EVERYONE, OTHER]) {
    for (const rights of [MODIFY, FULL, ADD_FILE]) {
      assert.throws(() => win(dir, opts({ [dir]: { aces: [...goodAces(), ace(sid, rights)] } })), /can be changed by other users/);
    }
  }
  assert.throws(() => launcher.writeLauncher('antigravity', process.execPath, '/x/runner.js', {
    env: { ZN_HOOK_DIR: dir }, platform: 'win32', hookDirTrustedRoot: TMP_ROOT, readWinAcls: fakeAcls({ [dir]: { aces: [...goodAces(), ace(USERS, MODIFY)] } }), setWinPrivate: () => {},
  }), /can be changed by other users/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('ZN_HOOK_DIR on Windows: a folder owned by another user is refused, SYSTEM and Administrators owners are fine', (t) => {
  const root = tempDir(t, 'zn-whd-o-');
  const dir = path.join(root, 'hooks');
  fs.mkdirSync(dir);
  assert.throws(() => win(dir, opts({ [dir]: { owner: OTHER } })), /belongs to another user/);
  win(dir, opts({ [dir]: { owner: ADMINS } }));
  win(dir, opts({ [dir]: { owner: SYSTEM } }));
  assert.throws(() => win(dir, opts({ [dir]: { owner: null } })), /belongs to another user/);
});

test('ZN_HOOK_DIR on Windows: an ancestor that others can delete, replace or re-permission is refused; read, create-only and inherit-only entries are not', (t) => {
  const root = tempDir(t, 'zn-whd-anc-');
  const up = path.join(root, 'up');
  const dir = path.join(up, 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const bad = (rights) => opts({ [up]: { aces: [...goodAces(), ace(USERS, rights)] } });
  assert.throws(() => win(dir, bad(DELETE_CHILD)), /a folder above it .* can be changed by other users/);
  assert.throws(() => win(dir, bad(0x10000)), /can be changed by other users/); // DELETE
  assert.throws(() => win(dir, bad(0x40000)), /can be changed by other users/); // WRITE_DAC
  assert.throws(() => win(dir, bad(0x80000)), /can be changed by other users/); // WRITE_OWNER
  assert.throws(() => win(dir, bad(0x10000000)), /can be changed by other users/); // GENERIC_ALL
  assert.throws(() => win(dir, opts({ [up]: { owner: OTHER } })), /a folder above it .* belongs to another user/);
  win(dir, bad(READ));
  win(dir, bad(ADD_FILE | 0x4)); // creating siblings is not replacing the launcher folder
  win(dir, opts({ [up]: { aces: [...goodAces(), ace(USERS, MODIFY, { inheritOnly: true })] } }));
  win(dir, opts({ [up]: { aces: [...goodAces(), { sid: USERS, rights: FULL, type: 'Deny', inheritOnly: false }] } }));
});

test('ZN_HOOK_DIR on Windows: when the access list cannot be read the folder is refused (fails closed)', (t) => {
  const root = tempDir(t, 'zn-whd-fail-');
  const dir = path.join(root, 'hooks');
  fs.mkdirSync(dir);
  assert.throws(() => win(dir, opts({ __fail: 'could not read the access list of the folder (boom)' })), /could not read the access list/);
  assert.throws(() => win(dir, { trustedRoot: TMP_ROOT, readWinAcls: () => ({ user: ME, entries: [] }), setWinPrivate: () => {} }), /access list could not be read/);
});

test('ZN_HOOK_DIR on Windows: a new folder that does not end up private is removed again', (t) => {
  const root = tempDir(t, 'zn-whd-new-');
  const dir = path.join(root, 'hooks');
  let n = 0;
  const readWinAcls = (paths) => {
    n += 1;
    const over = n === 1 ? {} : { [dir]: { aces: [...goodAces(), ace(USERS, MODIFY)] } };
    return fakeAcls(over)(paths);
  };
  assert.throws(() => win(dir, { trustedRoot: TMP_ROOT, readWinAcls, setWinPrivate: () => {} }), /can be changed by other users/);
  assert.equal(fs.existsSync(dir), false);
});

test('ZN_HOOK_DIR on Windows: a folder swapped for a bad one while the launcher is written removes the launcher', (t) => {
  const root = tempDir(t, 'zn-whd-swap-');
  const dir = path.join(root, 'hooks');
  fs.mkdirSync(dir);
  let n = 0;
  const readWinAcls = (paths) => {
    n += 1;
    return fakeAcls(n === 1 ? {} : { [dir]: { aces: [...goodAces(), ace(EVERYONE, FULL)] } })(paths);
  };
  assert.throws(() => launcher.writeLauncher('antigravity', process.execPath, '/x/runner.js', {
    env: { ZN_HOOK_DIR: dir }, platform: 'win32', hookDirTrustedRoot: TMP_ROOT, readWinAcls, setWinPrivate: () => {},
  }), /can be changed by other users/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

// ---- real ACLs (Windows only) -----------------------------------------------------------------------------------
const real = { skip: process.platform !== 'win32' };
const icacls = (...args) => {
  const r = spawnSync('icacls.exe', args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
};

// The temp folder of some accounts (SYSTEM: C:/Windows/Temp) lets Users create files and passes that on to subfolders, so the
// test folder is first made private to the account running the test.
const privateRoot = (root) => {
  const who = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout.trim().split(',')[1].replace(/"/g, '');
  icacls(root, '/inheritance:r', '/grant', '*' + who + ':(OI)(CI)F');
  return root;
};

test('real Windows: a new ZN_HOOK_DIR folder is owner-only; Users getting write access, or a junction in the path, is refused', real, (t) => {
  const root = privateRoot(tempDir(t, 'zn-whd-real-'));
  const o = { trustedRoot: TMP_ROOT };
  const dir = path.join(root, 'a', 'hooks');
  launcher.ensureSafeHookDir(dir, 'win32', o);
  launcher.ensureSafeHookDir(dir, 'win32', o); // second time, now it exists
  const acl = require('child_process').spawnSync('icacls.exe', [dir], { encoding: 'utf8' }).stdout;
  assert.doesNotMatch(acl, /BUILTIN.Users|Everyone|Authenticated Users/);
  icacls(dir, '/grant', '*S-1-5-32-545:(OI)(CI)M');
  assert.throws(() => launcher.ensureSafeHookDir(dir, 'win32', o), /can be changed by other users/);
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  const junction = path.join(root, 'junction');
  fs.symlinkSync(target, junction, 'junction');
  assert.throws(() => launcher.ensureSafeHookDir(path.join(junction, 'hooks'), 'win32', o), /link or junction is in its path/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('real Windows: an ancestor that Users can delete from is refused', real, (t) => {
  const root = privateRoot(tempDir(t, 'zn-whd-realanc-'));
  const up = path.join(root, 'up');
  const dir = path.join(up, 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  launcher.ensureSafeHookDir(dir, 'win32', { trustedRoot: TMP_ROOT }); // inherited from the temp folder: yours only
  icacls(up, '/grant', '*S-1-5-32-545:(DC)');
  assert.throws(() => launcher.ensureSafeHookDir(dir, 'win32', { trustedRoot: TMP_ROOT }), /a folder above it .* can be changed by other users/);
});

// The whole production chain (profile, Users, drive root) with the real ACLs, no trusted folder. Opt-in: it depends on the
// machine's own folders (ZN_WIN_REAL_CHAIN=1 is set by the VM job that proves the rule).
test('real Windows: the production rule accepts a new folder under the user profile', { skip: process.platform !== 'win32' || !process.env.ZN_WIN_REAL_CHAIN }, (t) => {
  const dir = path.join(os.homedir(), '.zn-test-hooks-' + process.pid, 'hooks');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  launcher.ensureSafeHookDir(dir, 'win32');
  assert.ok(fs.statSync(dir).isDirectory());
});
