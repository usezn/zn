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
    return { user: ME, entries: paths.map((p) => ({ path: p, owner: ME, aces: goodAces(), ...(over[p] || {}), ...(over.__file && fs.lstatSync(p).isFile() ? over.__file : {}) })) };
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
  assert.deepEqual(priv, [[path.join(root, 'a'), ME], [dir, ME]]); // every new level is made private, one at a time
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

// ---- Daybreak #1 blockers: system programs only, new folder race, launcher file ------------------------------------
const PS_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const fakeSpawn = (calls, reply) => (file, args, o) => { calls.push({ file, args, o }); return reply || { status: 0, stdout: 'U\t' + ME + '\nZ\n', stderr: '' }; };

test('ZN_HOOK_DIR on Windows: PowerShell is the absolute System32 one, with a minimal environment (no PSModulePath, no PATH from the caller)', (t) => {
  const calls = [];
  const saved = { PSModulePath: process.env.PSModulePath, PATH: process.env.PATH };
  process.env.PSModulePath = 'C:\\evil\\modules';
  process.env.PATH = 'C:\\evil\\bin';
  t.after(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const io = { spawnSync: fakeSpawn(calls), powershell: PS_PATH };
  launcher.readWinAcls(['C:\\a', 'C:\\a\\b'], io);
  launcher.setWinPrivate('C:\\a\\b', ME, io);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.file, PS_PATH); // never the bare name that the current folder or PATH could answer
    assert.ok(path.win32.isAbsolute(c.file));
    assert.deepEqual(Object.keys(c.o.env).filter((k) => !/^ZN_/.test(k)).sort(), ['PATH', 'PSModulePath', 'SystemDrive', 'SystemRoot', 'windir']);
    assert.equal(c.o.env.PATH, 'C:\\Windows\\System32');
    assert.equal(c.o.env.SystemRoot, 'C:\\Windows');
    // only the system module folder: the user's own Documents\WindowsPowerShell\Modules is never searched (not the inherited value either)
    assert.equal(c.o.env.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
    assert.equal(c.o.cwd, 'C:\\Windows');
    assert.deepEqual(c.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
  }
  // the ACL is read with .NET directly (no cmdlet, so no module to autoload) and the owner-only step does not use icacls
  assert.match(calls[0].args[5], /GetAccessControl/);
  assert.doesNotMatch(calls[0].args[5] + calls[1].args[5], /Get-Acl|icacls|ConvertTo-Json|New-Object/i);
  assert.equal(calls[1].o.env.ZN_SID, ME);
  assert.equal(calls[1].o.env.ZN_DIR, 'C:\\a\\b');
});

test('ZN_HOOK_DIR on Windows: without the system PowerShell, or with a failing one, the ACL calls fail closed', (t) => {
  assert.throws(() => launcher.readWinAcls(['C:\\a'], { powershell: null, spawnSync: fakeSpawn([]) }), /system PowerShell was not found/);
  assert.throws(() => launcher.setWinPrivate('C:\\a', ME, { powershell: null, spawnSync: fakeSpawn([]) }), /system PowerShell was not found/);
  assert.throws(() => launcher.readWinAcls(['C:\\a'], { powershell: PS_PATH, spawnSync: fakeSpawn([], { status: 1, stdout: '', stderr: 'boom' }) }), /could not read the access list/);
  assert.throws(() => launcher.readWinAcls(['C:\\a'], { powershell: PS_PATH, spawnSync: fakeSpawn([], { status: 0, stdout: 'not json', stderr: '' }) }), /unreadable answer/);
  assert.throws(() => launcher.setWinPrivate('C:\\a', 'S-1-5-21; calc', { powershell: PS_PATH, spawnSync: fakeSpawn([]) }), /unexpected account id/);
  if (process.platform !== 'win32') assert.throws(() => launcher.readWinAcls(['/x']), /system PowerShell was not found/); // the default is exe.systemPowerShell(), null off Windows
});

test('ZN_HOOK_DIR on Windows: another user who drops a file in the new folder before it is private makes zn refuse (race case)', (t) => {
  const root = tempDir(t, 'zn-whd-race-');
  const dir = path.join(root, 'hooks');
  // the "attacker" acts in the window between mkdir and the access list change
  const setWinPrivate = (d) => fs.writeFileSync(path.join(d, '.antigravity.' + process.pid + '.zn-tmp'), 'attacker');
  assert.throws(() => launcher.writeLauncher('antigravity', process.execPath, '/x/runner.js', {
    env: { ZN_HOOK_DIR: dir }, platform: 'win32', hookDirTrustedRoot: TMP_ROOT, readWinAcls: fakeAcls(), setWinPrivate,
  }), /not empty when it was made private/);
  assert.equal(fs.existsSync(path.join(dir, 'antigravity-hook.sh')), false);
  assert.ok(!fs.readdirSync(dir).some((n) => !/zn-tmp$/.test(n)), 'no launcher was written');
  // an empty new folder is fine
  const ok = path.join(root, 'ok');
  launcher.writeLauncher('antigravity', process.execPath, '/x/runner.js', {
    env: { ZN_HOOK_DIR: ok }, platform: 'win32', hookDirTrustedRoot: TMP_ROOT, readWinAcls: fakeAcls(), setWinPrivate: () => {},
  });
  assert.equal(fs.readdirSync(ok).length, 1);
});

test('ZN_HOOK_DIR on Windows: the launcher file itself is checked after it is written (owner, access list, link)', (t) => {
  const root = tempDir(t, 'zn-whd-file-');
  const dir = path.join(root, 'hooks');
  fs.mkdirSync(dir);
  const run = (over) => launcher.writeLauncher('antigravity', process.execPath, '/x/runner.js', {
    env: { ZN_HOOK_DIR: dir }, platform: 'win32', hookDirTrustedRoot: TMP_ROOT, readWinAcls: fakeAcls(over), setWinPrivate: () => {},
  });
  assert.throws(() => run({ __file: { owner: OTHER } }), /launcher file belongs to another user/);
  assert.deepEqual(fs.readdirSync(dir), []); // and it was removed
  for (const rights of [MODIFY, FULL, 0x2, 0x4, 0x10000, 0x40000, 0x80000]) {
    assert.throws(() => run({ __file: { aces: [...goodAces(), ace(USERS, rights)] } }), /launcher file can be changed by other users/);
    assert.deepEqual(fs.readdirSync(dir), []);
  }
  assert.throws(() => run({ __file: { reparse: true } }), /launcher is a link/);
  run({ __file: { aces: [...goodAces(), ace(USERS, READ)] } }); // read access for others is fine
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.equal(fs.readdirSync(dir).filter((n) => /zn-tmp/.test(n)).length, 0);
});

test('ZN_HOOK_DIR on Windows: an entry that new files inherit counts for the launcher folder even when it is inherit-only (C:\\ case)', (t) => {
  const root = tempDir(t, 'zn-whd-inh-');
  const dir = path.join(root, 'hooks');
  fs.mkdirSync(dir);
  const inh = (flags) => opts({ [dir]: { aces: [...goodAces(), ace('S-1-5-11', MODIFY, { inheritOnly: true, inh: flags })] } });
  assert.throws(() => win(dir, inh(3)), /can be changed by other users/); // (OI)(CI)(IO): the launcher would inherit Modify
  assert.throws(() => win(dir, inh(2)), /can be changed by other users/); // (OI)(IO)
  win(dir, inh(1)); // (CI)(IO): only subfolders
  // the same entry on a folder above does not matter
  const up = path.join(root, 'up');
  const leaf = path.join(up, 'hooks');
  fs.mkdirSync(leaf, { recursive: true });
  win(leaf, opts({ [up]: { aces: [...goodAces(), ace('S-1-5-11', MODIFY, { inheritOnly: true, inh: 3 })] } }));
});

test('ZN_HOOK_DIR on Windows: any reparse point in the path is refused (links, junctions, synced folders)', (t) => {
  const root = tempDir(t, 'zn-whd-rp-');
  const up = path.join(root, 'up');
  const dir = path.join(up, 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  assert.throws(() => win(dir, opts({ [up]: { reparse: true } })), /link, junction or synced folder is in its path/);
  assert.throws(() => win(dir, opts({ [dir]: { reparse: true } })), /link, junction or synced folder is in its path/);
  win(dir, opts({ [up]: { reparse: false } }));
});

test('ZN_HOOK_DIR on Windows: OWNER RIGHTS and TrustedInstaller entries are not "other users"', (t) => {
  const root = tempDir(t, 'zn-whd-ownr-');
  const dir = path.join(root, 'hooks');
  fs.mkdirSync(dir);
  const TI = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
  win(dir, opts({ [dir]: { aces: [...goodAces(), ace('S-1-3-4', FULL), ace(TI, FULL)] } }));
});

test('writeFileAtomic: the temporary file has an unpredictable name and is opened exclusively (a planted file is never used)', (t) => {
  const files = require('../lib/broker/files');
  const crypto = require('crypto');
  const root = tempDir(t, 'zn-wfa-');
  const target = path.join(root, 'launcher.sh');
  const names = [];
  const rename = fs.renameSync;
  fs.renameSync = (a, b) => { names.push(path.basename(a)); return rename(a, b); };
  t.after(() => { fs.renameSync = rename; });
  files.writeFileAtomic(target, 'one', 0o755);
  files.writeFileAtomic(target, 'two', 0o755);
  fs.renameSync = rename;
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
  for (const n of names) assert.match(n, new RegExp('^\\.launcher\\.sh\\.' + process.pid + '\\.[0-9a-f]{16}\\.zn-tmp$'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'two');
  assert.deepEqual(fs.readdirSync(root), ['launcher.sh']);
  // the old predictable name, and even the exact name this call would pick, are planted by "somebody else": refused, untouched
  const old = path.join(root, '.launcher.sh.' + process.pid + '.zn-tmp');
  fs.writeFileSync(old, 'attacker');
  files.writeFileAtomic(target, 'three', 0o755);
  assert.equal(fs.readFileSync(old, 'utf8'), 'attacker');
  const rb = crypto.randomBytes;
  crypto.randomBytes = () => Buffer.from('0123456789abcdef', 'hex');
  t.after(() => { crypto.randomBytes = rb; });
  const planted = path.join(root, '.launcher.sh.' + process.pid + '.0123456789abcdef.zn-tmp');
  fs.writeFileSync(planted, 'attacker');
  assert.throws(() => files.writeFileAtomic(target, 'four', 0o755), /EEXIST/);
  assert.equal(fs.readFileSync(planted, 'utf8'), 'attacker');
  assert.equal(fs.readFileSync(target, 'utf8'), 'three');
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

test('real Windows: a powershell.exe or icacls.exe planted in the current folder, and a hostile PSModulePath, are not used', real, (t) => {
  const plant = privateRoot(tempDir(t, 'zn-whd-plant-'));
  // a program that cannot answer: if zn ran it (by name, from the current folder), the call below would fail
  fs.copyFileSync(process.execPath, path.join(plant, 'powershell.exe'));
  fs.copyFileSync(process.execPath, path.join(plant, 'icacls.exe'));
  const mod = path.join(plant, 'Microsoft.PowerShell.Security');
  fs.mkdirSync(mod);
  const prevCwd = process.cwd();
  const prevPsm = process.env.PSModulePath;
  process.chdir(plant);
  process.env.PSModulePath = plant;
  try {
    const doc = launcher.readWinAcls([plant]);
    assert.match(doc.user, /^S-1-5-/);
    assert.equal(doc.entries.length, 1);
    const sub = path.join(plant, 'sub');
    fs.mkdirSync(sub);
    launcher.setWinPrivate(sub, doc.user);
    launcher.ensureSafeHookDir(path.join(plant, 'new', 'hooks'), 'win32', { trustedRoot: TMP_ROOT });
  } finally {
    // back first: the current folder must not be the one that is removed, and later tests must not look for programs in it
    process.chdir(prevCwd);
    if (prevPsm === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = prevPsm;
  }
});

test('real Windows: a launcher is written, its own owner and access list are checked, and a junction in the path is refused', real, (t) => {
  const root = privateRoot(tempDir(t, 'zn-whd-realw-'));
  const dir = path.join(root, 'x', 'hooks');
  const file = launcher.writeLauncher('antigravity', process.execPath, 'C:/x/runner.js', { env: { ZN_HOOK_DIR: dir }, platform: 'win32', hookDirTrustedRoot: TMP_ROOT });
  assert.ok(fs.statSync(file).isFile());
  assert.equal(fs.readdirSync(dir).filter((n) => /zn-tmp/.test(n)).length, 0);
  const doc = launcher.readWinAcls([file]);
  assert.equal(launcher.winProblem(doc.entries[0], doc.user, 'file'), null);
  icacls(file, '/grant', '*S-1-5-32-545:(M)');
  const again = launcher.readWinAcls([file]);
  assert.match(launcher.winProblem(again.entries[0], again.user, 'file'), /can be changed by other users/);
});

// Another account's private folder (C:\znh made by an admin): Windows refuses even to look at it, so it seemed missing and zn
// went on to create it, ending in a raw "EEXIST: file already exists, mkdir". The fake fs below plays that account's folder.
test('ZN_HOOK_DIR on Windows: a folder of another account is named in plain words, never a raw EEXIST or EPERM', (t) => {
  const root = tempDir(t, 'zn-whd-other-');
  const theirs = path.join(root, 'znh');
  const eperm = (p) => Object.assign(new Error("EPERM: operation not permitted, lstat '" + p + "'"), { code: 'EPERM', path: p });
  const orig = { lstatSync: fs.lstatSync, existsSync: fs.existsSync, mkdirSync: fs.mkdirSync };
  fs.lstatSync = (p, ...a) => { if (p === theirs || p.startsWith(theirs + path.sep)) throw eperm(p); return orig.lstatSync(p, ...a); };
  fs.existsSync = (p) => (p === theirs || p.startsWith(theirs + path.sep) ? false : orig.existsSync(p));
  fs.mkdirSync = (p, ...a) => { if (p === theirs) throw Object.assign(new Error("EEXIST: file already exists, mkdir '" + p + "'"), { code: 'EEXIST', path: p }); return orig.mkdirSync(p, ...a); };
  const msgs = [];
  try {
    for (const dir of [theirs, path.join(theirs, 'hooks')]) {
      try { win(dir, opts()); assert.fail('expected a refusal'); } catch (e) { msgs.push(e.message); }
    }
  } finally { Object.assign(fs, orig); }
  for (const msg of msgs) {
    assert.ok(msg.includes('your account cannot open ' + theirs + ': it belongs to another account'), msg);
    assert.match(msg, /unset ZN_HOOK_DIR/);
    assert.doesNotMatch(msg, /EEXIST|EPERM|mkdir '|lstat '/);
  }
});

test('ZN_HOOK_DIR on Windows: a level that cannot be created is named in plain words (EEXIST from a folder that appeared)', (t) => {
  const root = tempDir(t, 'zn-whd-race-');
  const dir = path.join(root, 'hooks');
  const orig = fs.mkdirSync;
  fs.mkdirSync = (p, ...a) => { if (p === dir) throw Object.assign(new Error("EEXIST: file already exists, mkdir '" + p + "'"), { code: 'EEXIST', path: p }); return orig(p, ...a); };
  let msg = '';
  try { win(dir, opts()); } catch (e) { msg = e.message; } finally { fs.mkdirSync = orig; }
  assert.ok(msg.includes(dir + ' already exists, but your account cannot see it'), msg);
  assert.doesNotMatch(msg, /EEXIST|mkdir '/);
});
