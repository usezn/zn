'use strict';
/*
 * A `#!` script is opened again by its interpreter after zn's last check. zn run refuses to give secrets to a
 * script that group or others can write (or a folder above it), or that another account owns; a script only the
 * current user can write is allowed with a warning.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const exe = require('../lib/exe');
const winacl = require('../lib/vault/winacl');
const { runBroker } = require('../lib/broker/run');
const { createFakeVault } = require('./helpers/fake_vault');
const { generateAll } = require('./fixtures/fake_secrets');

const POSIX = process.platform !== 'win32';
const PG = generateAll(778, { perType: 1, piiPerType: 1 }).secrets.find((s) => s.type === 'postgres_connection_string').sensitive;

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

// Under the package, not the temp dir: programs in the temp dir are refused anyway.
function scratch(t) {
  const base = fs.mkdtempSync(path.join(__dirname, 'zn-scr-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

function risk(file, o) {
  const a = exe.openExecutable(file);
  try { return exe.scriptRisk(a, file, o); } finally { fs.closeSync(a.fd); }
}

// Same, in the system temp directory: for the tests of scriptRisk alone (zn run itself refuses programs there).
function scratchTmp(t) {
  const d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zn-scr-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// The folders above must be ones only the current user can write, or the tests below say nothing.
function ancestorsAreTight(from) {
  let cur = path.resolve(from);
  for (;;) {
    let st;
    try { st = fs.statSync(cur); } catch (_) { return false; }
    if ((st.mode & 0o022) !== 0 && !(st.isDirectory() && (st.mode & 0o1000))) return false;
    const p = path.dirname(cur);
    if (p === cur) return true;
    cur = p;
  }
}
const TIGHT = POSIX && ancestorsAreTight(__dirname); // package folder (zn run integration)
const TIGHT_TMP = POSIX && ancestorsAreTight(require('os').tmpdir());
const NOT_ROOT = POSIX && process.getuid() !== 0;

test('openExecutable tells a `#!` script from a native program', { skip: !POSIX }, (t) => {
  const dir = scratch(t);
  const s = path.join(dir, 's.sh');
  fs.writeFileSync(s, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  const a = exe.openExecutable(s);
  const b = exe.openExecutable(fs.realpathSync(process.execPath));
  try {
    assert.equal(a.script, true);
    assert.equal(b.script, false);
  } finally { fs.closeSync(a.fd); fs.closeSync(b.fd); }
});

test('scriptRisk: a script only you can write passes with a warning', { skip: !TIGHT_TMP || !NOT_ROOT }, (t) => {
  const dir = scratchTmp(t);
  const s = path.join(dir, 's.sh');
  fs.writeFileSync(s, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  const r = risk(s);
  assert.equal(r.deny, null);
  assert.ok(r.warn, 'warns');
});

test('scriptRisk: a native program and a missing descriptor are not scripts', { skip: !POSIX }, () => {
  const b = exe.openExecutable(fs.realpathSync(process.execPath));
  try { assert.equal(exe.scriptRisk(b, process.execPath), null); } finally { fs.closeSync(b.fd); }
  assert.equal(exe.scriptRisk(null, '/x'), null);
});

test('scriptRisk: a group- or other-writable script is refused', { skip: !POSIX }, (t) => {
  const dir = scratch(t);
  for (const mode of [0o775, 0o757, 0o777, 0o770 | 0o002]) {
    const s = path.join(dir, 's' + mode.toString(8) + '.sh');
    fs.writeFileSync(s, '#!/bin/sh\n');
    fs.chmodSync(s, mode);
    const r = risk(s);
    assert.match(r.deny, /group or others can write/, mode.toString(8));
  }
  const g = path.join(dir, 'g.sh');
  fs.writeFileSync(g, '#!/bin/sh\n');
  fs.chmodSync(g, 0o775);
  assert.match(risk(g).deny, /group or others/);
});

test('scriptRisk: a group- or other-writable folder above the script is refused, a sticky one is not', { skip: !TIGHT_TMP }, (t) => {
  const dir = scratchTmp(t);
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  const s = path.join(sub, 's.sh');
  fs.writeFileSync(s, '#!/bin/sh\n', { mode: 0o555 });
  fs.chmodSync(sub, 0o775);
  assert.match(risk(s).deny, /sub \(group or others can write it\)/);
  fs.chmodSync(sub, 0o757);
  assert.match(risk(s).deny, /group or others/);
  fs.chmodSync(sub, 0o1777);
  assert.equal(risk(s).deny, null, 'sticky folder');
  fs.chmodSync(sub, 0o700);
  assert.equal(risk(s).deny, null);
});

test('scriptRisk: a script owned by another non-root account is refused', { skip: !TIGHT_TMP || !NOT_ROOT }, (t) => {
  const dir = scratchTmp(t);
  const s = path.join(dir, 's.sh');
  fs.writeFileSync(s, '#!/bin/sh\n', { mode: 0o755 });
  const a = exe.openExecutable(s);
  const real = process.getuid;
  process.getuid = () => real.call(process) + 4242; // as if the file belonged to someone else
  try { assert.match(exe.scriptRisk(a, s).deny, /belongs to another account/); } finally { process.getuid = real; fs.closeSync(a.fd); }
});

test('scriptRisk: a root-owned script under /usr/bin passes silently', { skip: !POSIX || process.getuid() === 0 }, () => {
  let found = null;
  for (const d of ['/usr/bin', '/bin']) {
    let names = [];
    try { names = fs.readdirSync(d); } catch (_) { continue; }
    for (const n of names) {
      const p = path.join(d, n);
      try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022)) continue;
        const fd = fs.openSync(p, 'r');
        const b = Buffer.alloc(2);
        fs.readSync(fd, b, 0, 2, 0);
        fs.closeSync(fd);
        if (b[0] === 0x23 && b[1] === 0x21) { found = fs.realpathSync(p); break; }
      } catch (_) { /* next */ }
    }
    if (found) break;
  }
  if (!found) return; // no `#!` program under /usr/bin on this system
  assert.equal(risk(found), null);
});

async function runTool(dir, opts) {
  const marker = path.join(dir, 'ran');
  const s = path.join(dir, 'tool.sh');
  fs.writeFileSync(s, '#!/bin/sh\necho ran > "' + marker + '"\n');
  fs.chmodSync(s, opts.mode);
  const vault = createFakeVault({ withApprovals: true });
  await vault.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: ['tool.sh'] });
  const err = sink();
  const code = await runBroker(['--secrets', 'DB_PASSWORD', '--', 'tool.sh'], {
    vault,
    env: { PATH: dir + path.delimiter + '/usr/bin:/bin' },
    stdout: sink(),
    stderr: err,
    stdin: { isTTY: false },
    approvals: { isApproved: async () => true, recordApproval: async () => {} },
    project: '/nonexistent-project',
  });
  return { code, err: err.text(), ran: fs.existsSync(marker), vault };
}

test('zn run refuses a group-writable script, audits it, and starts nothing', { skip: !POSIX }, async (t) => {
  const r = await runTool(scratch(t), { mode: 0o775 });
  assert.equal(r.code, 77, r.err);
  assert.match(r.err, /others can rewrite/);
  assert.ok(!r.ran, 'the script was not started');
  assert.ok(r.vault.auditLog.some((e) => e.decision === 'deny' && /group or others/.test(e.reason)));
});

test('zn run starts your own script (0755) with a warning and an audit note', { skip: !TIGHT || process.getuid() === 0 }, async (t) => {
  const r = await runTool(scratch(t), { mode: 0o755 });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.ran, 'the script was started');
  assert.match(r.err, /warning: `tool\.sh` is a script you can rewrite/);
  assert.ok(r.vault.auditLog.some((e) => e.decision === 'allow' && /script writable by the current user/.test(e.reason)));
});

test('zn run still starts a native program with a secret, without a warning', { skip: !POSIX }, async () => {
  const vault = createFakeVault({ withApprovals: true });
  const NODE = path.basename(process.execPath);
  await vault.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: [NODE] });
  const out = sink();
  const err = sink();
  const code = await runBroker(['--secrets', 'DB_PASSWORD', '--', NODE, '-e', 'console.log("ok")'], {
    vault,
    env: { PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') },
    stdout: out,
    stderr: err,
    stdin: { isTTY: false },
    approvals: { isApproved: async () => true, recordApproval: async () => {} },
  });
  assert.equal(code, 0);
  assert.match(out.text(), /ok/);
  assert.doesNotMatch(err.text(), /you can rewrite/);
});

/* ------------------------- Windows (.cmd, .bat) ------------------------- */

const ME = 'S-1-5-21-1-2-3-1001';
const OTHER = 'S-1-5-21-1-2-3-1002';
const base = 'O:' + ME + 'G:DUD:PAI(A;;FA;;;' + ME + ')(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;BU)';
const E = (sddl, dir, p) => ({ path: p || 'C:\\x', dir: !!dir, sddl });

test('rightsMask reads letter pairs and hex', () => {
  assert.equal(winacl.rightsMask('FA'), 0x1f01ff);
  assert.equal(winacl.rightsMask('0x1301bf'), 0x1301bf);
  assert.ok(winacl.rightsMask('FRFX') & 0x1);
  assert.equal(winacl.rightsMask('FRFX') & 0x2, 0);
});

test('Windows: a script only you, SYSTEM and administrators can write has a warning, no denial', () => {
  const r = winacl.scriptEntriesRisk([E(base, false, 'C:\\u\\npm\\a.cmd'), E(base, true, 'C:\\u\\npm')], ME);
  assert.equal(r.deny, null);
  assert.equal(r.warn, 'C:\\u\\npm\\a.cmd');
});

test('Windows: a script under Program Files that only administrators write passes silently', () => {
  const adminOnly = 'O:BAG:BAD:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;0x1200a9;;;BU)';
  const r = winacl.scriptEntriesRisk([E(adminOnly, false), E(adminOnly, true)], ME);
  assert.deepEqual(r, { deny: null, warn: null });
});

test('Windows: another principal that can write the file or a folder above it is refused', () => {
  const evil = base + '(A;;0x1301bf;;;' + OTHER + ')';
  assert.match(winacl.scriptEntriesRisk([E(evil, false)], ME).deny, /can write it/);
  assert.match(winacl.scriptEntriesRisk([E(base, false), E(evil, true, 'C:\\zn')], ME).deny, /C:\\zn/);
  const users = 'O:' + ME + 'G:DUD:PAI(A;;FA;;;' + ME + ')(A;;FRFXFW;;;BU)';
  assert.match(winacl.scriptEntriesRisk([E(users, false)], ME).deny, /the Users group can write/);
  const everyone = 'O:' + ME + 'G:DUD:PAI(A;;FA;;;WD)';
  assert.match(winacl.scriptEntriesRisk([E(everyone, true)], ME).deny, /Everyone can write/);
});

test('Windows: a folder where users may add subfolders (C:\\) or an inherit-only entry is not a finding', () => {
  const root = 'O:SYG:SYD:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x4;;;AU)(A;OICIIO;0x1301bf;;;AU)';
  assert.equal(winacl.scriptEntriesRisk([E(root, true, 'C:\\')], ME).deny, null);
});

test('Windows: a script owned by another account, or with no access list, is refused', () => {
  const owned = 'O:' + OTHER + 'G:DUD:PAI(A;;FA;;;' + ME + ')';
  assert.match(winacl.scriptEntriesRisk([E(owned, false)], ME).deny, /owned by/);
  assert.match(winacl.scriptEntriesRisk([E('O:' + ME, false)], ME).deny, /no access list/);
});

test('Windows: scriptWriteRisk reads the file and its folders in one call and fails closed', () => {
  const calls = [];
  const tools = {
    powershell: 'ps.exe',
    whoami: 'whoami.exe',
    run(file, args) {
      calls.push(file);
      if (file === 'whoami.exe') return { status: 0, stdout: '"u","' + ME + '"\n' };
      return { status: 0, stdout: 'F|C:\\u\\a.cmd|' + base + '\nD|C:\\u|' + base + '\nD|C:\\|' + base + '\n' };
    },
  };
  const ok = winacl.scriptWriteRisk('C:\\u\\a.cmd', { tools });
  assert.equal(ok.deny, null);
  assert.equal(ok.warn, 'C:\\u\\a.cmd');
  assert.equal(calls.filter((c) => c === 'ps.exe').length, 1);
  const bad = winacl.scriptWriteRisk('C:\\u\\a.cmd', { tools: { ...tools, run: (f) => (f === 'whoami.exe' ? { status: 0, stdout: '"u","' + ME + '"' } : { status: 1, stdout: '', stderr: 'boom' }) } });
  assert.match(bad.deny, /could not be read/);
  const empty = winacl.scriptWriteRisk('C:\\u\\a.cmd', { tools: { ...tools, run: (f) => (f === 'whoami.exe' ? { status: 0, stdout: '"u","' + ME + '"' } : { status: 0, stdout: '' }) } });
  assert.match(empty.deny, /could not be read/);
});

test('Windows: scriptRisk uses the Windows check for a .cmd/.bat descriptor', () => {
  const tools = {
    powershell: 'ps.exe',
    whoami: 'whoami.exe',
    run: (f) => (f === 'whoami.exe' ? { status: 0, stdout: '"u","' + ME + '"' } : { status: 0, stdout: 'F|C:\\u\\a.cmd|' + base + '(A;;0x1301bf;;;' + OTHER + ')\nD|C:\\u|' + base + '\n' }),
  };
  const r = exe.scriptRisk({ script: true }, 'C:\\u\\a.cmd', { platform: 'win32', tools });
  assert.match(r.deny, /can write it/);
  assert.equal(exe.scriptRisk({ script: false }, 'C:\\u\\a.cmd', { platform: 'win32', tools }), null);
});
