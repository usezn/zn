'use strict';
/* Windows permissions for the vault: the logic with a stubbed command runner (it runs on every system). */
const test = require('node:test');
const assert = require('node:assert/strict');
const winacl = require('../lib/vault/winacl');

const ME = 'S-1-5-21-111-222-333-1001';
const PIPE = '\\\\.\\pipe\\zn-vault-test';
const OTHER_GROUP = 'S-1-5-32-545'; // Users
const GOOD_DIR = 'O:' + ME + 'G:S-1-5-21-111-222-333-513D:PAI(A;OICI;FA;;;' + ME + ')';
const OPEN_DIR = 'O:' + ME + 'G:S-1-5-21-111-222-333-513D:AI(A;OICIID;FA;;;' + ME + ')(A;OICIID;0x1200a9;;;BU)(A;OICIID;FA;;;SY)';

// What each PowerShell text does, told apart by the .NET calls it makes.
const kindOf = (args) => {
  const script = args[args.length - 1];
  if (script.includes('WindowsIdentity')) return 'sid';
  if (script.includes('SetAccessRuleProtection')) return 'set';
  return 'read';
};

function fake(initial, opts) {
  const o = opts || {};
  const calls = [];
  let sddl = initial;
  const tools = {
    powershell: o.noPowershell ? null : 'powershell',
    run(file, args, env) {
      const kind = kindOf(args);
      calls.push({ file, args, env, kind });
      if (kind === 'sid') return o.sidFails ? { status: 1, stdout: '', stderr: 'Exception' } : { status: 0, stdout: ME + '\r\n' };
      if (kind === 'set') {
        if (o.setFails) return { status: 1, stdout: '', stderr: 'UnauthorizedAccessException: denied' };
        sddl = o.afterApply || GOOD_DIR;
        return { status: 0, stdout: '' };
      }
      return { status: 0, stdout: sddl };
    },
  };
  return { tools, calls };
}

test('the account SID comes from the process token through the system PowerShell, not from another program', () => {
  const { tools, calls } = fake(GOOD_DIR);
  assert.equal(winacl.currentUserSid(tools), ME);
  assert.deepEqual(calls.map((c) => [c.file, c.kind]), [['powershell', 'sid']]);
  for (const stdout of ['', 'S-1-5-21-1-2-3-1001 extra', '"x","' + ME + '"', 'S-1-5-21-1-2-3-1001\nS-1-5-18']) {
    const t = { powershell: 'powershell', run: () => ({ status: 0, stdout }) };
    assert.throws(() => winacl.currentUserSid(t), (e) => e.code === 'ZN_POLICY_DENIED' && /account SID/.test(e.message), JSON.stringify(stdout));
  }
  assert.throws(() => winacl.currentUserSid(fake(GOOD_DIR, { sidFails: true }).tools), (e) => e.code === 'ZN_POLICY_DENIED');
});

test('no other program is started: only the system PowerShell', () => {
  for (const initial of [GOOD_DIR, OPEN_DIR]) {
    const { tools, calls } = fake(initial);
    winacl.ensurePrivate('C:\\zn\\vault', { dir: true, tools });
    assert.ok(calls.every((c) => c.file === 'powershell'), JSON.stringify(calls.map((c) => c.file)));
    assert.ok(calls.every((c) => !/icacls|whoami/i.test(c.args.join(' '))));
  }
});

test('parseSddl reads owner, flags and entries', () => {
  const a = winacl.parseSddl(OPEN_DIR);
  assert.equal(a.owner, ME);
  assert.equal(a.flags, 'AI');
  assert.equal(a.aces.length, 3);
  assert.deepEqual(a.aces[1], { type: 'A', flags: 'OICIID', rights: '0x1200a9', sid: 'BU' });
});

test('an owner-only protected list has no problems; inherited or shared access is reported', () => {
  assert.deepEqual(winacl.problems(GOOD_DIR, ME, { dir: true }), []);
  const p = winacl.problems(OPEN_DIR, ME, { dir: true });
  assert.ok(p.some((x) => /inherits/.test(x)));
  assert.ok(p.some((x) => /BU/.test(x)));
  // SYSTEM and Administrators (by SID or by alias) are accepted, another user or group is not
  assert.deepEqual(winacl.problems('O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;' + ME + ')', ME, { dir: true }), []);
  assert.ok(winacl.problems('O:BAD:P(A;;FA;;;' + OTHER_GROUP + ')', ME, { dir: true }).length > 0);
  assert.ok(winacl.problems('O:BAD:P(A;;FA;;;S-1-1-0)', ME, {}).some((x) => /S-1-1-0/.test(x)));
  // a deny entry only narrows access
  assert.deepEqual(winacl.problems('O:' + ME + 'D:P(D;;FA;;;BU)(A;;FA;;;' + ME + ')', ME, { dir: true }), []);
});

test('another owner or a missing access list is a problem (an owner can rewrite the list)', () => {
  assert.ok(winacl.problems('O:S-1-5-21-9-9-9-1500D:P(A;;FA;;;' + ME + ')', ME, { dir: true }).some((x) => /owner/.test(x)));
  assert.ok(winacl.problems('O:' + ME + 'G:BA', ME, {}).some((x) => /everyone/.test(x)));
});

test('ensurePrivate leaves a private folder alone', () => {
  const { tools, calls } = fake(GOOD_DIR);
  winacl.ensurePrivate('C:\\zn\\vault', { dir: true, tools });
  assert.equal(calls.filter((c) => c.kind === 'set').length, 0);
});

test('ensurePrivate replaces the list with a protected one that grants only the current SID, then reads it back', () => {
  const { tools, calls } = fake(OPEN_DIR);
  winacl.ensurePrivate('C:\\zn\\vault', { dir: true, tools });
  assert.deepEqual(calls.map((c) => c.kind), ['sid', 'read', 'set', 'read']);
  const set = calls.find((c) => c.kind === 'set');
  assert.deepEqual(set.env, { ZN_ACL_PATH: 'C:\\zn\\vault', ZN_ACL_SID: ME, ZN_ACL_DIR: '1' });
  const script = set.args[set.args.length - 1];
  // a new list (nothing kept from the old one), protected from inheritance, one FullControl allow entry inherited by files and folders
  assert.ok(script.includes('[System.Security.AccessControl.DirectorySecurity]::new()'));
  assert.ok(script.includes('$acl.SetAccessRuleProtection($true, $false)'));
  assert.ok(script.includes('([int]1 -bor [int]2)') && script.includes('FullControl') && script.includes('::Allow'));
  assert.equal(script.match(/AddAccessRule/g).length, 2, 'one entry for a folder, one for a file');
  // the path and the SID travel in the environment, never inside the PowerShell text
  assert.ok(calls.filter((c) => c.kind !== 'sid').every((c) => c.env.ZN_ACL_PATH === 'C:\\zn\\vault' && !c.args.join(' ').includes('C:\\zn') && !c.args.join(' ').includes(ME)));
});

test('a file gets a file entry (no inheritance flags)', () => {
  const { tools, calls } = fake('O:' + ME + 'D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;' + ME + ')', { afterApply: 'O:' + ME + 'D:P(A;;FA;;;' + ME + ')' });
  winacl.ensurePrivate('C:\\zn\\run\\session.key', { dir: false, tools });
  const set = calls.find((c) => c.kind === 'set');
  assert.deepEqual(set.env, { ZN_ACL_PATH: 'C:\\zn\\run\\session.key', ZN_ACL_SID: ME, ZN_ACL_DIR: '0' });
  assert.ok(set.args[set.args.length - 1].includes('[System.Security.AccessControl.FileSecurity]::new()'));
});

test('it refuses when the permissions cannot be set, cannot be read, or are still open afterwards', () => {
  for (const [initial, opts] of [
    [OPEN_DIR, { setFails: true }],
    [OPEN_DIR, { afterApply: OPEN_DIR }],
    [OPEN_DIR, { noPowershell: true }],
  ]) {
    const { tools } = fake(initial, opts);
    assert.throws(() => winacl.ensurePrivate('D:\\zn', { dir: true, tools }), (e) => e.code === 'ZN_POLICY_DENIED' && /will not keep the vault there/.test(e.message));
  }
  const bad = fake(GOOD_DIR, { sidFails: true });
  assert.throws(() => winacl.ensurePrivate('D:\\zn', { dir: true, tools: bad.tools }), (e) => e.code === 'ZN_POLICY_DENIED');
  const denied = fake(OPEN_DIR, { setFails: true });
  assert.throws(() => winacl.ensurePrivate('D:\\zn', { dir: true, tools: denied.tools }), (e) => /could not set its permissions: UnauthorizedAccessException/.test(e.message));
  const garbage = fake('');
  assert.throws(() => winacl.ensurePrivate('D:\\zn', { dir: true, tools: garbage.tools }), (e) => e.code === 'ZN_POLICY_DENIED');
});

test('the pipe gets one entry for the user and one for SYSTEM through one connection, read back there', () => {
  const calls = [];
  const tools = {
    powershell: 'powershell',
    run(file, args, env) {
      calls.push({ file, args, env, kind: kindOf(args) });
      if (kindOf(args) === 'sid') return { status: 0, stdout: ME };
      return { status: 0, stdout: 'O:' + ME + 'D:P(A;;FA;;;' + ME + ')(A;;FA;;;SY)' };
    },
  };
  winacl.ensurePipe(PIPE, { tools });
  const ps = calls.filter((c) => c.kind !== 'sid');
  assert.equal(ps.length, 1, 'one connection only');
  assert.equal(ps[0].env.ZN_ACL_SID, ME);
  assert.equal(ps[0].env.ZN_ACL_PATH, PIPE);
  const script = ps[0].args[ps[0].args.length - 1];
  assert.ok(script.includes("D:P(A;;FA;;;' + $env:ZN_ACL_SID + ')(A;;FA;;;SY)"));
  assert.ok(script.includes('ChangePermissions') && script.includes('SetAccessControl'));
  assert.ok(!script.includes('zn-vault-test'), 'the name travels in the environment');
});

test('the pipe is refused when the result still lets another account in, or it cannot be set', () => {
  const who = { status: 0, stdout: ME };
  const open = { powershell: 'powershell', run: (f, a) => (kindOf(a) === 'sid' ? who : { status: 0, stdout: 'O:' + ME + 'D:(A;;FA;;;WD)' }) };
  assert.throws(() => winacl.ensurePipe(PIPE, { tools: open }), (e) => e.code === 'ZN_POLICY_DENIED');
  const failing = { powershell: 'powershell', run: (f, a) => (kindOf(a) === 'sid' ? who : { status: 1, stdout: '', stderr: 'Exception: pipe busy' }) };
  assert.throws(() => winacl.ensurePipe(PIPE, { tools: failing }), (e) => e.code === 'ZN_POLICY_DENIED' && /pipe busy/.test(e.message));
});

test('the built-in Administrator (RID 500): SDDL writes the user itself as LA and it is accepted; others stay refused', () => {
  const ADM = 'S-1-5-21-111-222-333-500';
  assert.deepEqual(winacl.problems('O:LAG:S-1-5-21-111-222-333-513D:PAI(A;OICI;FA;;;LA)', ADM, { dir: true }), []);
  assert.deepEqual(winacl.problems('O:LAD:PAI(A;OICI;FA;;;' + ADM + ')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)', ADM, { dir: true }), []);
  assert.deepEqual(winacl.problems('O:BAD:P(A;;FA;;;LA)', ADM, {}), []);
  // a standard user: LA is a different account (the machine Administrator), so it is not trusted
  assert.ok(winacl.problems('O:' + ME + 'D:P(A;;FA;;;LA)', ME, {}).some((x) => /LA/.test(x)));
  assert.ok(winacl.problems('O:LAD:P(A;;FA;;;' + ME + ')', ME, {}).some((x) => /owner/.test(x)));
  // an Administrator of another machine (different domain prefix) is not this user
  assert.ok(winacl.problems('O:S-1-5-21-9-9-9-500D:P(A;;FA;;;S-1-5-21-9-9-9-500)', ADM, {}).length > 0);
  // another user, Everyone, Guest alias, unknown alias: refused
  assert.ok(winacl.problems('O:LAD:P(A;;FA;;;' + ME + ')', ADM, {}).some((x) => /allows/.test(x)));
  assert.ok(winacl.problems('O:LAD:P(A;;FA;;;WD)', ADM, {}).some((x) => /WD/.test(x)));
  assert.ok(winacl.problems('O:LAD:P(A;;FA;;;LG)', ADM, {}).some((x) => /LG/.test(x)));
  assert.ok(winacl.problems('O:LAD:P(A;;FA;;;ZZ)', ADM, {}).some((x) => /ZZ/.test(x)));
  assert.ok(winacl.problems('O:ZZD:P(A;;FA;;;LA)', ADM, {}).some((x) => /owner/.test(x)));
  // LA with a user that has no machine SID cannot be resolved: refused
  assert.ok(winacl.problems('O:LAD:P(A;;FA;;;LA)', 'S-1-5-18', {}).some((x) => /LA/.test(x)));
});

test('ensurePrivate accepts the SDDL of the built-in Administrator and checks scripts with LA the same way', () => {
  const ADM = 'S-1-5-21-111-222-333-500';
  const t = fake('O:LAG:S-1-5-21-111-222-333-513D:PAI(A;OICI;FA;;;LA)').tools;
  assert.doesNotThrow(() => winacl.ensurePrivate('C:\zn', { dir: true, tools: t, userSid: ADM }));
  assert.deepEqual(winacl.scriptEntriesRisk([{ path: 'C:\s\a.cmd', dir: false, sddl: 'O:LAD:P(A;;FA;;;LA)(A;;FA;;;SY)' }], ADM).deny, null);
  assert.match(winacl.scriptEntriesRisk([{ path: 'C:\s\a.cmd', dir: false, sddl: 'O:LAD:P(A;;FA;;;LA)' }], ME).deny, /owned by LA/);
});

test('real Windows: a folder and a file open to the Users group are made owner-only and read back as private', { skip: process.platform !== 'win32' }, (t) => {
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const { tempDir } = require('./helpers/tmp');
  winacl._forget();
  const me = winacl.currentUserSid(winacl.realTools());
  const dir = tempDir(t, 'zn-winacl-');
  const file = path.join(dir, 'session.key');
  fs.writeFileSync(file, 'x');
  // test setup only (zn itself starts no icacls): give the Users group modify rights on both
  for (const [p, grant] of [[dir, '*S-1-5-32-545:(OI)(CI)M'], [file, '*S-1-5-32-545:M']]) {
    const r = spawnSync('icacls.exe', [p, '/grant', grant], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  assert.ok(winacl.verifyPrivate(dir, { dir: true }).length > 0, 'the folder starts open');
  winacl.ensurePrivate(dir, { dir: true });
  winacl.ensurePrivate(file, { dir: false });
  assert.deepEqual(winacl.verifyPrivate(dir, { dir: true }), []);
  assert.deepEqual(winacl.verifyPrivate(file, {}), []);
  const acl = winacl.parseSddl(spawnSync(require('../lib/exe').systemPowerShell(), ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::Out.Write([System.IO.DirectoryInfo]::new($env:ZN_T).GetAccessControl().GetSecurityDescriptorSddlForm('Access'))"], { encoding: 'utf8', env: { ...process.env, ZN_T: dir } }).stdout);
  assert.match(acl.flags, /P/);
  assert.deepEqual(acl.aces.map((a) => [a.type, a.flags, a.rights]), [['A', 'OICI', 'FA']]);
  // SDDL writes the built-in Administrator (GitHub's Windows runners) as LA
  assert.ok(acl.aces[0].sid === me || acl.aces[0].sid === 'LA', acl.aces[0].sid);
});

test('on other systems the real entry points do nothing', { skip: process.platform === 'win32' }, () => {
  winacl.ensurePrivate('/nonexistent/x', { dir: true });
  winacl.ensurePipe('/nonexistent/x.sock');
});
