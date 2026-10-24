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

function fake(initial, opts) {
  const o = opts || {};
  const calls = [];
  let sddl = initial;
  const tools = {
    icacls: 'icacls',
    whoami: 'whoami',
    powershell: o.noPowershell ? null : 'powershell',
    run(file, args, env) {
      calls.push({ file, args, env });
      if (file === 'whoami') return { status: 0, stdout: '"DESKTOP\\me","' + ME + '"\r\n' };
      if (file === 'icacls') {
        if (o.icaclsFails) return { status: 5, stdout: '' };
        if (args[1] === '/grant:r') sddl = o.afterApply || GOOD_DIR;
        return { status: 0, stdout: 'ok' };
      }
      return { status: 0, stdout: sddl };
    },
  };
  return { tools, calls };
}

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
  assert.equal(calls.filter((c) => c.file === 'icacls').length, 0);
});

test('ensurePrivate resets, protects and grants only the current SID, then reads it back', () => {
  const { tools, calls } = fake(OPEN_DIR);
  winacl.ensurePrivate('C:\\zn\\vault', { dir: true, tools });
  const ic = calls.filter((c) => c.file === 'icacls').map((c) => c.args);
  assert.deepEqual(ic, [
    ['C:\\zn\\vault', '/reset'],
    ['C:\\zn\\vault', '/inheritance:r'],
    ['C:\\zn\\vault', '/grant:r', '*' + ME + ':(OI)(CI)F'],
  ]);
  // the path travels in the environment, never inside the PowerShell text
  const ps = calls.filter((c) => c.file === 'powershell');
  assert.equal(ps.length, 2);
  assert.ok(ps.every((c) => c.env.ZN_ACL_PATH === 'C:\\zn\\vault' && !c.args.join(' ').includes('C:\\zn')));
});

test('a file gets a file grant (no inheritance flags)', () => {
  const { tools, calls } = fake('O:' + ME + 'D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;' + ME + ')', { afterApply: 'O:' + ME + 'D:P(A;;FA;;;' + ME + ')' });
  winacl.ensurePrivate('C:\\zn\\run\\session.key', { dir: false, tools });
  const grant = calls.find((c) => c.file === 'icacls' && c.args[1] === '/grant:r');
  assert.deepEqual(grant.args, ['C:\\zn\\run\\session.key', '/grant:r', '*' + ME + ':F']);
});

test('it refuses when the permissions cannot be set, cannot be read, or are still open afterwards', () => {
  for (const [initial, opts] of [
    [OPEN_DIR, { icaclsFails: true }],
    [OPEN_DIR, { afterApply: OPEN_DIR }],
    [OPEN_DIR, { noPowershell: true }],
  ]) {
    const { tools } = fake(initial, opts);
    assert.throws(() => winacl.ensurePrivate('D:\\zn', { dir: true, tools }), (e) => e.code === 'ZN_POLICY_DENIED' && /will not keep the vault there/.test(e.message));
  }
  const bad = fake(GOOD_DIR);
  bad.tools.whoami = null;
  assert.throws(() => winacl.ensurePrivate('D:\\zn', { dir: true, tools: bad.tools }), (e) => e.code === 'ZN_POLICY_DENIED');
  const garbage = fake('');
  assert.throws(() => winacl.ensurePrivate('D:\\zn', { dir: true, tools: garbage.tools }), (e) => e.code === 'ZN_POLICY_DENIED');
});

test('the pipe gets one entry for the user and one for SYSTEM through one connection, read back there', () => {
  const calls = [];
  const tools = {
    whoami: 'whoami',
    powershell: 'powershell',
    run(file, args, env) {
      calls.push({ file, args, env });
      if (file === 'whoami') return { status: 0, stdout: '"x","' + ME + '"' };
      return { status: 0, stdout: 'O:' + ME + 'D:P(A;;FA;;;' + ME + ')(A;;FA;;;SY)' };
    },
  };
  winacl.ensurePipe(PIPE, { tools });
  const ps = calls.filter((c) => c.file === 'powershell');
  assert.equal(ps.length, 1, 'one connection only');
  assert.equal(ps[0].env.ZN_ACL_SID, ME);
  assert.equal(ps[0].env.ZN_ACL_PATH, PIPE);
  const script = ps[0].args[ps[0].args.length - 1];
  assert.ok(script.includes("D:P(A;;FA;;;' + $env:ZN_ACL_SID + ')(A;;FA;;;SY)"));
  assert.ok(script.includes('ChangePermissions') && script.includes('SetAccessControl'));
  assert.ok(!script.includes('zn-vault-test'), 'the name travels in the environment');
});

test('the pipe is refused when the result still lets another account in, or it cannot be set', () => {
  const who = { status: 0, stdout: '"x","' + ME + '"' };
  const open = { whoami: 'whoami', powershell: 'powershell', run: (f) => (f === 'whoami' ? who : { status: 0, stdout: 'O:' + ME + 'D:(A;;FA;;;WD)' }) };
  assert.throws(() => winacl.ensurePipe(PIPE, { tools: open }), (e) => e.code === 'ZN_POLICY_DENIED');
  const failing = { whoami: 'whoami', powershell: 'powershell', run: (f) => (f === 'whoami' ? who : { status: 1, stdout: '', stderr: 'Exception: pipe busy' }) };
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

test('on other systems the real entry points do nothing', { skip: process.platform === 'win32' }, () => {
  winacl.ensurePrivate('/nonexistent/x', { dir: true });
  winacl.ensurePipe('/nonexistent/x.sock');
});
