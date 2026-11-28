'use strict';
/*
 * zn run: the refusals of prepare() (secret not usable, program not safe, approval or value missing) and the
 * re-verification that spawnChecked() does after the secrets path decided (program changed or swapped between
 * the check and the start, script risk seen again, Windows batch files). Static fake commands only: nothing in
 * this file starts a program that does anything but write a marker file.
 *
 * Seams: the `approvals` option of runBroker is called after the program was opened and fingerprinted and before it
 * is started, so a test can change the file there, exactly the window the re-verification closes. exe.scriptRisk,
 * fs.realpathSync.native and process.platform are read at call time, so the Windows-only branches run on any host
 * with narrow stubs that are always restored.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const exe = require('../lib/exe');
const markers = require('../lib/broker/markers');
const run = require('../lib/broker/run');
const { createFakeVault } = require('./helpers/fake_vault');
const { generateAll } = require('./fixtures/fake_secrets');
const { moveTempRoot, assertFixturesOutsideTemp } = require('./_exe_fixture');
// The program checks refuse anything in a temp folder first: move the temp root away from the package so these fixtures reach them.
moveTempRoot();

const { runBroker, prepare, parseRunArgs, batchInvocation, cmdQuote } = run;
const POSIX = process.platform !== 'win32';
const NOT_ROOT = POSIX && process.getuid() !== 0;
const PG = generateAll(779, { perType: 1, piiPerType: 1 }).secrets.find((s) => s.type === 'postgres_connection_string').sensitive;
const NODE = path.basename(process.execPath);

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

function scratch(t) {
  const base = fs.mkdtempSync(path.join(__dirname, 'zn-rej-'));
  assertFixturesOutsideTemp(base);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

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
const TIGHT = POSIX && ancestorsAreTight(__dirname);

function withPlatform(platform, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  const restore = () => Object.defineProperty(process, 'platform', desc);
  let r;
  try { r = fn(); } catch (e) { restore(); throw e; }
  if (r && typeof r.then === 'function') return r.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
  restore();
  return r;
}

function withRealpathNative(impl, fn) {
  const orig = fs.realpathSync.native;
  fs.realpathSync.native = impl;
  const restore = () => { fs.realpathSync.native = orig; };
  let r;
  try { r = fn(); } catch (e) { restore(); throw e; }
  if (r && typeof r.then === 'function') return r.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
  restore();
  return r;
}

function withScriptRisk(impl, fn) {
  const orig = exe.scriptRisk;
  exe.scriptRisk = impl;
  const restore = () => { exe.scriptRisk = orig; };
  let r;
  try { r = fn(); } catch (e) { restore(); throw e; }
  if (r && typeof r.then === 'function') return r.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
  restore();
  return r;
}

const WIN_CMD = 'C:\\Windows\\System32\\cmd.exe';
const REAL_NATIVE = fs.realpathSync.native;
// Stub for the kernel's SystemRoot link only: every other path keeps its real answer (the temp-folder and project checks use it too).
const winNative = (p) => (/GLOBALROOT/.test(p) || p === WIN_CMD ? WIN_CMD : REAL_NATIVE(p));

// A script `tool.sh` that only writes a marker; returns the folder pieces.
function makeTool(dir, name = 'tool.sh') {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const marker = path.join(dir, 'ran');
  const file = path.join(bin, name);
  fs.writeFileSync(file, '#!/bin/sh\necho ran > "' + marker + '"\n');
  fs.chmodSync(file, 0o755);
  return { bin, marker, file };
}

async function runWith(dir, o) {
  const vault = o.vault || createFakeVault({ withApprovals: true });
  if (!o.vault) await vault.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: [o.command || 'tool.sh'] });
  const err = sink();
  const code = await runBroker(o.args || ['--secrets', 'DB_PASSWORD', '--', o.command || 'tool.sh'], {
    vault,
    env: { PATH: o.bin + path.delimiter + '/usr/bin:/bin', ...(o.env || {}) },
    stdout: sink(),
    stderr: err,
    stdin: { isTTY: false },
    approvals: o.approvals || { isApproved: async () => true, recordApproval: async () => {} },
    project: '/nonexistent-project',
  });
  return { code, err: err.text(), vault };
}

// ---- prepare(): early return and refusals --------------------------------------------------------------------

test('prepare without any secret returns the command untouched and opens nothing', async () => {
  const parsed = parseRunArgs(['--', 'some-fake-tool', '--flag']);
  const env = { PATH: '/nonexistent', KEEP: 'yes' };
  const prep = await prepare(parsed, { env, cwd: '/nonexistent-cwd', project: '/nonexistent-project', vault: null });
  assert.deepEqual(prep.argv, ['some-fake-tool', '--flag']);
  assert.deepEqual(prep.secrets, []);
  assert.equal(prep.resolved, null);
  assert.equal(prep.project, '/nonexistent-project');
  assert.equal(prep.env.KEEP, 'yes');
  assert.notEqual(prep.env, env, 'the environment is copied');
});

test('prepare refuses a secret that the vault does not have (127) and one blocked by policy (77)', { skip: !POSIX }, async (t) => {
  const dir = scratch(t);
  const { bin } = makeTool(dir);
  const none = await runWith(dir, { bin, vault: createFakeVault({ withApprovals: true }) });
  assert.equal(none.code, 127, none.err);
  assert.match(none.err, /is not in the vault/);
  assert.ok(none.vault.auditLog.some((e) => e.decision === 'deny' && e.secret === 'DB_PASSWORD'));

  const blocked = createFakeVault({ withApprovals: true });
  await blocked.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: ['tool.sh'] });
  const listed = blocked.listSecrets;
  blocked.listSecrets = async (o) => (await listed(o)).map((x) => ({ ...x, deny: true })); // as the daemon with an organization deny rule
  const b = await runWith(dir, { bin, vault: blocked });
  assert.equal(b.code, 77, b.err);
  assert.match(b.err, /blocked for this agent by your organization policy/);
});

test('prepare refuses a proxy-mode secret and a command that is not allowed for the secret', { skip: !POSIX }, async (t) => {
  const dir = scratch(t);
  const { bin, marker } = makeTool(dir);
  const proxy = createFakeVault({ withApprovals: true });
  await proxy.setSecret('DB_PASSWORD', PG, { mode: 'proxy', allowCommands: ['tool.sh'] });
  const p = await runWith(dir, { bin, vault: proxy });
  assert.equal(p.code, 77, p.err);
  assert.match(p.err, /proxy mode, so zn run never puts it in a process/);

  const other = createFakeVault({ withApprovals: true });
  await other.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: ['another-tool'] });
  const o = await runWith(dir, { bin, vault: other });
  assert.equal(o.code, 77, o.err);
  assert.match(o.err, /`tool\.sh` is not allowed to use DB_PASSWORD yet/);
  assert.ok(!fs.existsSync(marker), 'nothing was started');
});

test('prepare names the program, the secret and the safe way out when a script is refused (scriptDenial)', { skip: !POSIX }, async (t) => {
  const dir = scratch(t);
  const { bin, marker } = makeTool(dir);
  const r = await withScriptRisk(() => ({ deny: '/fake/folder (group or others can write it)', warn: null }), () => runWith(dir, { bin }));
  assert.equal(r.code, 77, r.err);
  assert.match(r.err, /`tool\.sh` is a script that others can rewrite \(\/fake\/folder \(group or others can write it\)\)/);
  assert.match(r.err, /so zn run will not give it DB_PASSWORD/);
  assert.match(r.err, /run it through its interpreter, for example: zn run -- bash \.\/script\.sh/);
  assert.ok(!fs.existsSync(marker), 'the script was not started');
  const denial = r.vault.auditLog.find((e) => e.decision === 'deny');
  assert.ok(denial && /others can rewrite/.test(denial.reason), 'the refusal is audited');
  assert.ok(!r.vault.auditLog.some((e) => e.decision === 'allow'));
});

test('an optional named marker is left alone (not injected) when the script is refused', { skip: !POSIX }, async (t) => {
  const dir = scratch(t);
  const { bin, marker } = makeTool(dir);
  const vault = createFakeVault({ withApprovals: true });
  await vault.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: ['tool.sh'] });
  const r = await withScriptRisk(() => ({ deny: '/fake/folder (group or others can write it)', warn: null }), () => runWith(dir, {
    bin,
    vault,
    args: ['--', 'tool.sh'],
    env: { INHERITED: 'x ' + markers.markerFor('DB_PASSWORD') + ' y' },
  }));
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(marker), 'the program itself still runs, with the marker unchanged');
  assert.match(r.err, /left as markers in the environment \(not allowed or not yet approved for `tool\.sh`\): DB_PASSWORD/);
  assert.ok(!r.vault.auditLog.some((e) => e.decision === 'allow'), 'no secret was released');
});

test('prepare refuses when the first-use approval is rejected, with the reason and nothing run', { skip: !POSIX }, async (t) => {
  const dir = scratch(t);
  const { bin, marker } = makeTool(dir);
  for (const [thrown, expected] of [
    [Object.assign(new Error('the user said no'), { code: 'ZN_POLICY_DENIED' }), /the user said no/],
    [new Error('dialog unavailable'), /dialog unavailable/],
    [{}, /not approved/],
  ]) {
    const r = await runWith(dir, {
      bin,
      approvals: { isApproved: async () => false, recordApproval: async () => { throw thrown; } },
    });
    assert.equal(r.code, 77, r.err);
    assert.match(r.err, /first use of DB_PASSWORD with `tool\.sh` was not approved \(/);
    assert.match(r.err, expected);
    assert.match(r.err, /first use of DB_PASSWORD with `tool\.sh`: confirm it in the zn vault prompt/);
    assert.ok(r.vault.auditLog.some((e) => e.decision === 'deny' && /was not approved/.test(e.reason)));
    assert.ok(!fs.existsSync(marker), 'nothing was started');
  }
});

test('prepare refuses a secret whose value the vault no longer has (127)', { skip: !POSIX }, async (t) => {
  const dir = scratch(t);
  const { bin, marker } = makeTool(dir);
  const vault = createFakeVault({ withApprovals: true });
  await vault.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: ['tool.sh'] });
  vault.resolve = async () => null;
  const r = await runWith(dir, { bin, vault });
  assert.equal(r.code, 127, r.err);
  assert.match(r.err, /secret DB_PASSWORD has no value in the vault/);
  assert.ok(!fs.existsSync(marker));
});

// ---- spawnChecked(): re-verification after the secrets path --------------------------------------------------

test('a script rewritten between the check and the start is refused, and neither version runs', { skip: !TIGHT || !NOT_ROOT }, async (t) => {
  const dir = scratch(t);
  const { bin, marker, file } = makeTool(dir);
  let swapped = false;
  const r = await runWith(dir, {
    bin,
    approvals: {
      isApproved: async () => {
        if (!swapped) { swapped = true; fs.appendFileSync(file, 'echo swapped >> "' + marker + '"\n'); } // same file, new content
        return true;
      },
      recordApproval: async () => {},
    },
  });
  assert.ok(swapped, 'the seam ran');
  assert.equal(r.code, 77, r.err);
  assert.match(r.err, /`tool\.sh`: the program changed after it was checked/);
  assert.match(r.err, /it was not started/);
  assert.match(r.err, /something is replacing the program/);
  assert.ok(!fs.existsSync(marker), 'the program was not started');
});

test('a folder above the script swapped for another one is refused as a different file', { skip: !TIGHT || !NOT_ROOT }, async (t) => {
  const dir = scratch(t);
  const { bin, marker } = makeTool(dir);
  let swapped = false;
  const r = await runWith(dir, {
    bin,
    approvals: {
      isApproved: async () => {
        if (!swapped) {
          swapped = true;
          // The opened file is untouched (same descriptor, same fingerprint); the path now leads to a lookalike.
          fs.renameSync(bin, bin + '.old');
          fs.mkdirSync(bin);
          fs.writeFileSync(path.join(bin, 'tool.sh'), '#!/bin/sh\necho evil > "' + marker + '"\n', { mode: 0o755 });
        }
        return true;
      },
      recordApproval: async () => {},
    },
  });
  assert.ok(swapped, 'the seam ran');
  assert.equal(r.code, 77, r.err);
  assert.match(r.err, /the path now leads to a different file/);
  assert.match(r.err, /it was not started/);
  assert.ok(!fs.existsSync(marker), 'neither the old nor the new script ran');
});

test('a script that becomes unsafe after verifyOpen passes is refused by the second risk check', { skip: !POSIX }, async (t) => {
  const dir = scratch(t);
  const { bin, marker } = makeTool(dir);
  let calls = 0;
  // First look (prepare): nothing to say. Second look (just before start): others can write it now.
  const r = await withScriptRisk(() => { calls += 1; return calls === 1 ? null : { deny: '/fake/folder (group or others can write it)', warn: null }; }, () => runWith(dir, { bin }));
  assert.equal(calls, 2, 'scriptRisk ran in prepare and again before start');
  assert.equal(r.code, 77, r.err);
  assert.match(r.err, /`tool\.sh` is a script that others can rewrite \(\/fake\/folder \(group or others can write it\)\); it was not started/);
  assert.match(r.err, /Put the script where only you can write/);
  assert.ok(!fs.existsSync(marker), 'the script was not started');
});

test('the second risk check lets a safe script through (control for the test above)', { skip: !POSIX }, async (t) => {
  const dir = scratch(t);
  const { bin, marker } = makeTool(dir);
  const r = await withScriptRisk(() => null, () => runWith(dir, { bin }));
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(marker));
});

test('a program that could not be started synchronously is reported, not crashed (spawn throws)', { skip: !POSIX }, async () => {
  const err = sink();
  // A NUL byte in an argument makes child_process.spawn throw before anything starts.
  const code = await runBroker(['--', process.execPath, 'a\u0000b'], { stdout: sink(), stderr: err, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(code, 1, err.text());
  assert.match(err.text(), /^zn run: /);
});

// ---- Windows-only branches, with narrow stubs ----------------------------------------------------------------

test('systemCmdExe: only on Windows, only the kernel path, resolved twice', () => {
  assert.equal(withPlatform('linux', () => run.systemCmdExe()), null);
  withPlatform('win32', () => {
    assert.equal(withRealpathNative(() => WIN_CMD, () => run.systemCmdExe()), WIN_CMD);
    assert.equal(withRealpathNative(() => { throw new Error('no such link'); }, () => run.systemCmdExe()), null, 'first lookup fails');
    for (const odd of ['\\\\?\\UNC\\server\\share\\System32\\cmd.exe', 'C:\\Windows\\System32\\evil.exe', 'C:\\Win%dows\\System32\\cmd.exe', 'C:\\Win!dows\\System32\\cmd.exe', 'C:\\Win"dows\\System32\\cmd.exe']) {
      assert.equal(withRealpathNative(() => odd, () => run.systemCmdExe()), null, odd);
    }
    let n = 0;
    assert.equal(withRealpathNative(() => (++n === 1 ? WIN_CMD : 'D:\\Remapped\\System32\\cmd.exe'), () => run.systemCmdExe()), null, 'a remapped drive letter');
    n = 0;
    assert.equal(withRealpathNative(() => { if (++n === 1) return WIN_CMD; throw new Error('gone'); }, () => run.systemCmdExe()), null, 'second lookup fails');
    n = 0;
    assert.equal(withRealpathNative(() => (++n === 1 ? WIN_CMD : WIN_CMD.toUpperCase()), () => run.systemCmdExe()), WIN_CMD, 'case alone is not a difference');
  });
});

test('batchInvocation: quoted line for cmd.exe, and refusals for touched or metacharacter arguments', () => {
  withPlatform('win32', () => {
    withRealpathNative(() => WIN_CMD, () => {
      const b = batchInvocation('C:\\tools\\build.cmd', ['one two', 'plain'], ['one two', 'plain']);
      assert.equal(b.file, WIN_CMD);
      assert.deepEqual(b.args, ['/d', '/v:off', '/s', '/c', '""C:\\tools\\build.cmd" "one two" "plain""']);
      for (const bad of ['a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a%PATH%', 'a!b', 'a"b', 'a\nb', 'a\rb']) {
        assert.throws(() => batchInvocation('C:\\tools\\build.cmd', [bad], [bad]), (e) => e.code === 'ZN_POLICY_DENIED' && /batch file/.test(e.message), JSON.stringify(bad));
      }
      assert.throws(() => batchInvocation('C:\\tools\\build.cmd', ['value'], ['marker']), (e) => e.code === 'ZN_POLICY_DENIED' && /will not pass secret values/.test(e.message), 'an argument zn changed');
      for (const bad of ['C:\\to%ols\\build.cmd', 'C:\\to!ols\\build.cmd', 'C:\\to"ols\\build.cmd']) {
        assert.throws(() => batchInvocation(bad, [], []), (e) => e.code === 'ZN_POLICY_DENIED', bad);
      }
    });
    withRealpathNative(() => { throw new Error('no cmd'); }, () => {
      assert.throws(() => batchInvocation('C:\\tools\\build.cmd', [], []), (e) => e.code === 'ZN_POLICY_DENIED' && /could not find the system cmd\.exe; it was not started/.test(e.message));
    });
  });
});

test('cmdQuote doubles the backslashes before a quote and before the closing quote', () => {
  assert.equal(cmdQuote('plain'), '"plain"');
  assert.equal(cmdQuote('trail\\'), '"trail\\\\"');
  assert.equal(cmdQuote('a\\"b'), '"a\\\\""b"');
  assert.equal(cmdQuote(12), '"12"');
});

test('zn run refuses a batch file with a metacharacter argument on Windows, before anything is started', { skip: !POSIX }, async (t) => {
  const dir = scratch(t);
  const { bin, marker } = makeTool(dir, 'tool.cmd');
  const r = await withPlatform('win32', () => withScriptRisk(() => null, () => withRealpathNative(winNative, () => runWith(dir, {
    bin,
    command: 'tool.cmd',
    args: ['--secrets', 'DB_PASSWORD', '--', 'tool.cmd', 'a&b'],
  }))));
  assert.equal(r.code, 77, r.err);
  assert.match(r.err, /tool\.cmd is a batch file: zn run will not pass secret values or shell metacharacters through cmd\.exe/);
  assert.ok(!fs.existsSync(marker));
});

test('zn run refuses a batch file when the system cmd.exe cannot be found on Windows', { skip: !POSIX }, async (t) => {
  const dir = scratch(t);
  const { bin, marker } = makeTool(dir, 'tool.cmd');
  const r = await withPlatform('win32', () => withScriptRisk(() => null, () => withRealpathNative((p) => { if (/GLOBALROOT/.test(p)) throw new Error('no link'); return REAL_NATIVE(p); }, () => runWith(dir, { bin, command: 'tool.cmd' }))));
  assert.equal(r.code, 77, r.err);
  assert.match(r.err, /could not find the system cmd\.exe; it was not started/);
  assert.ok(!fs.existsSync(marker));
});

test('zn run starts a batch file only through the system cmd.exe on Windows (never the script path directly)', { skip: !POSIX }, async (t) => {
  const dir = scratch(t);
  const { bin, marker } = makeTool(dir, 'tool.cmd');
  // Stubbed Windows on a POSIX host: there is no cmd.exe to start, so the start fails with "not installed". What matters
  // is that the program asked for is cmd.exe and the batch file never ran by itself.
  const r = await withPlatform('win32', () => withScriptRisk(() => null, () => withRealpathNative(winNative, () => runWith(dir, { bin, command: 'tool.cmd' }))));
  assert.equal(r.code, 127, r.err);
  assert.match(r.err, /`tool\.cmd` is not installed, or it is not on your PATH/);
  assert.ok(!fs.existsSync(marker), 'the batch file did not run on its own');
});

test('on Windows the secret environment drops any NoDefaultCurrentDirectoryInExePath spelling and sets it to 1', { skip: !POSIX }, async (t) => {
  const dir = scratch(t);
  const { bin } = makeTool(dir);
  const vault = createFakeVault({ withApprovals: true });
  await vault.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: ['tool.sh'] });
  const parsed = parseRunArgs(['--secrets', 'DB_PASSWORD', '--', 'tool.sh']);
  const env = { PATH: bin + path.delimiter + '/usr/bin:/bin', nodefaultcurrentdirectoryinexepath: '0', NoDefaultCurrentDirectoryInExePath: '0' };
  const prep = await withPlatform('win32', () => withScriptRisk(() => null, () => prepare(parsed, {
    env,
    vault,
    stderr: false,
    project: '/nonexistent-project',
    approvals: { isApproved: async () => true, recordApproval: async () => {} },
  })));
  try {
    const keys = Object.keys(prep.env).filter((k) => k.toLowerCase() === 'nodefaultcurrentdirectoryinexepath');
    assert.deepEqual(keys, ['NoDefaultCurrentDirectoryInExePath']);
    assert.equal(prep.env.NoDefaultCurrentDirectoryInExePath, '1');
    assert.equal(prep.secrets.length, 1);
  } finally {
    if (prep.exe && prep.exe.opened) { try { fs.closeSync(prep.exe.opened.fd); } catch (_) { /* closed */ } }
  }
});
