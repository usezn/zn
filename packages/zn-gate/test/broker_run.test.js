'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

const markers = require('../lib/broker/markers');
const { createMasker, variantsOf } = require('../lib/broker/mask');
const { runBroker, parseRunArgs } = require('../lib/broker/run');
const { createFakeVault } = require('./helpers/fake_vault');
const { generateAll } = require('./fixtures/fake_secrets');
const { tempDir } = require('./helpers/tmp');

const FAKE = generateAll(777, { perType: 1, piiPerType: 1 });
const PG = FAKE.secrets.find((s) => s.type === 'postgres_connection_string').sensitive;
const GHP = FAKE.secrets.find((s) => s.type === 'github_pat_classic').value;

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

const NODE = path.basename(process.execPath).replace(/\.exe$/i, '');
const nodeEnv = { PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') };

async function setup(meta = {}) {
  const vault = createFakeVault({ withApprovals: true });
  await vault.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: [NODE], ...meta });
  return vault;
}

/* ------------------------------ markers ---------------------------- */

test('marker names: valid, reserved and invalid', () => {
  assert.equal(markers.validateSecretName('GITHUB_TOKEN'), null);
  assert.match(markers.validateSecretName('AWS_KEY_1'), /reserved/);
  assert.ok(markers.validateSecretName('lower'));
  assert.ok(markers.validateSecretName('A__B'));
  assert.equal(markers.substitute('x __ZN_A__ __ZN_B__', new Map([['A', '1']])), 'x 1 __ZN_B__');
});

test('a program inside the project is refused, also when the project is reached through a symlink', { skip: process.platform === 'win32' }, () => {
  // Under the package, not the temp dir: programs in the temp dir are refused anyway.
  const base = fs.mkdtempSync(path.join(__dirname, 'zn-exe-'));
  try {
    const real = path.join(base, 'real');
    const link = path.join(base, 'link');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(real, 'bin'), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(real, link);
    const tool = path.join(real, 'bin', 'tool');
    const other = path.join(outside, 'tool');
    fs.writeFileSync(tool, '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(other, '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync(other, path.join(real, 'bin', 'alias'));
    assert.match(markers.checkResolvedExecutable(tool, link), /inside the project/);
    assert.match(markers.checkResolvedExecutable(tool, real), /inside the project/);
    // A link inside the project that points at a program elsewhere is still a project name.
    assert.match(markers.checkResolvedExecutable(path.join(real, 'bin', 'alias'), real), /inside the project/);
    assert.equal(markers.checkResolvedExecutable(other, link), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('allowCommands matching is by prefix and never by explicit path', () => {
  assert.equal(markers.matchAllowCommands(['npm run migrate'], ['npm', 'run', 'migrate', '--x']), 'npm run migrate');
  assert.equal(markers.matchAllowCommands(['npm run migrate'], ['npm', 'run', 'dev']), null);
  assert.equal(markers.matchAllowCommands(['psql'], ['./psql']), null);
  assert.equal(markers.matchAllowCommands(['psql'], ['/tmp/x/psql']), null);
  assert.equal(markers.matchAllowCommands(['psql'], ['psql', '-c', 'select 1']), 'psql');
});

test('hosts: exact and wildcard subdomains only', () => {
  assert.equal(markers.hostAllowed(['api.github.com'], 'api.github.com'), true);
  assert.equal(markers.hostAllowed(['api.github.com'], 'evil.example'), false);
  assert.equal(markers.hostAllowed(['*.example.com'], 'a.example.com'), true);
  assert.equal(markers.hostAllowed(['*.example.com'], 'example.com'), false);
  assert.equal(markers.hostAllowed(['*.example.com'], 'badexample.com'), false);
});

/* ------------------------------- mask ------------------------------ */

test('masker catches raw, base64 at any offset, hex and url-encoded forms', () => {
  const v = 'p@ss w0rd/+=' + PG;
  const m = createMasker([{ name: 'DB_PASSWORD', value: v }]);
  const forms = [
    v,
    Buffer.from(v).toString('base64'),
    Buffer.from('u:' + v).toString('base64'),
    Buffer.from('ab:' + v).toString('base64'),
    Buffer.from(v).toString('base64url'),
    Buffer.from(v).toString('hex'),
    Buffer.from(v).toString('hex').toUpperCase(),
    encodeURIComponent(v),
  ];
  for (const f of forms) {
    const out = m.maskText('before ' + f + ' after');
    assert.ok(out.includes('__ZN_DB_PASSWORD__'), 'masked: ' + f.slice(0, 12));
    assert.ok(!out.includes(v), 'raw value gone');
  }
  assert.ok(variantsOf(v).length >= 6);
});

test('streaming masker handles values split across chunks and binary data', () => {
  const m = createMasker([{ name: 'X', value: PG }]);
  const payload = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.from('line ' + PG + ' end ' + Buffer.from(PG).toString('hex')), Buffer.from([1, 2, 254])]);
  for (const size of [1, 3, 7, 64]) {
    const s = m.stream();
    const parts = [];
    for (let i = 0; i < payload.length; i += size) parts.push(s.write(payload.subarray(i, i + size)));
    parts.push(s.end());
    const out = Buffer.concat(parts);
    assert.ok(!out.toString('latin1').includes(PG), 'chunk ' + size);
    assert.equal(out[0], 0);
    assert.equal(out[1], 255);
    assert.equal(out[out.length - 1], 254);
    assert.equal(out.toString('latin1').split('__ZN_X__').length - 1, 2);
  }
});

/* ------------------------------- run ------------------------------- */

test('parseRunArgs requires -- and validates names', () => {
  assert.deepEqual(parseRunArgs(['--secrets', 'A,B', '--', 'node', '-v']), { secrets: ['A', 'B'], command: ['node', '-v'] });
  assert.throws(() => parseRunArgs(['node']), /usage/);
  assert.throws(() => parseRunArgs(['--secrets', 'KEY_1', '--', 'x']), /reserved/);
});

test('zn run injects into argv for an allowed command and masks the output', async () => {
  const vault = await setup();
  const stdout = sink();
  const stderr = sink();
  const code = await runBroker(['--', NODE, '-e', 'const v=process.argv[1]; console.log("arg:" + v); console.log(Buffer.from(v).toString("base64")); console.error("err " + v)', 'postgres://app:__ZN_DB_PASSWORD__@db/app'], {
    vault, env: nodeEnv, stdout, stderr, stdin: { isTTY: false }, approvals: { isApproved: async () => true, recordApproval: async () => {} },
  });
  assert.equal(code, 0, stderr.text());
  assert.ok(!stdout.text().includes(PG));
  assert.ok(!stderr.text().includes(PG));
  assert.match(stdout.text(), /arg:postgres:\/\/app:__ZN_DB_PASSWORD__@db\/app/);
  assert.ok(vault.auditLog.some((e) => e.decision === 'allow' && e.secret === 'DB_PASSWORD' && e.argv0 === NODE));
  assert.ok(vault.auditLog.every((e) => !JSON.stringify(e).includes(PG)), 'audit holds no values');
});

test('zn run --secrets sets the env var only in the child', async () => {
  const vault = await setup();
  const stdout = sink();
  const code = await runBroker(['--secrets', 'DB_PASSWORD', '--', NODE, '-e', 'console.log(process.env.DB_PASSWORD === ' + JSON.stringify(PG) + ' ? "match" : "nomatch")'], {
    vault, env: nodeEnv, stdout, stderr: sink(), stdin: { isTTY: false }, approvals: { isApproved: async () => true, recordApproval: async () => {} },
  });
  assert.equal(code, 0);
  assert.equal(stdout.text().trim(), 'match');
  assert.equal(process.env.DB_PASSWORD, undefined);
});

test('zn run drops dynamic loader variables when secret values are injected, and says so once', async () => {
  const vault = await setup();
  const stdout = sink();
  const stderr = sink();
  const loaderEnv = { ...nodeEnv, LD_PRELOAD: '/nonexistent/hook.so', DYLD_INSERT_LIBRARIES: '/nonexistent/hook.dylib', LD_ZN_KEPT_WITHOUT_VALUES: 'kept' };
  const probe = 'console.log(["LD_PRELOAD","DYLD_INSERT_LIBRARIES","GCONV_PATH","NODE_PATH","PYTHONPATH","PERL5OPT","JAVA_TOOL_OPTIONS","BASH_ENV"].map((k) => process.env[k] === undefined ? "gone" : "present").join(" ") + "|" + (process.platform === "win32" ? process.env.NoDefaultCurrentDirectoryInExePath : "1"))';
  const extra = { GCONV_PATH: '/nonexistent/gconv', NODE_PATH: '/nonexistent/mods', PYTHONPATH: '/x', PERL5OPT: '-Mx', JAVA_TOOL_OPTIONS: '-javaagent:x', BASH_ENV: '/x' };
  const code = await runBroker(['--secrets', 'DB_PASSWORD', '--', NODE, '-e', probe], {
    vault, env: { ...loaderEnv, ...extra }, stdout, stderr, stdin: { isTTY: false }, approvals: { isApproved: async () => true, recordApproval: async () => {} },
  });
  assert.equal(code, 0, stderr.text());
  assert.equal(stdout.text().trim(), 'gone gone gone gone gone gone gone gone|1');
  assert.equal((stderr.text().match(/removed .*LD_PRELOAD/g) || []).length, 1, 'said once');
  assert.ok(!stderr.text().includes('/nonexistent/hook'), 'the values of the variables are not printed');
});

test('zn run passes loader variables through when no secret value is injected', async () => {
  const stdout = sink();
  const loaderEnv = { ...nodeEnv, LD_ZN_KEPT_WITHOUT_VALUES: 'kept' };
  const code = await runBroker(['--', NODE, '-e', 'console.log(process.env.LD_ZN_KEPT_WITHOUT_VALUES)'], {
    vault: createFakeVault(), env: loaderEnv, stdout, stderr: sink(), stdin: { isTTY: false },
  });
  assert.equal(code, 0);
  assert.equal(stdout.text().trim(), 'kept');
});

test('zn run refuses a command outside allowCommands and points to secrets_http_request', async () => {
  const vault = await setup({ allowCommands: ['psql'] });
  const stderr = sink();
  const code = await runBroker(['--', NODE, '-e', 'console.log(process.argv[1])', '__ZN_DB_PASSWORD__'], { vault, env: nodeEnv, stdout: sink(), stderr, stdin: { isTTY: false } });
  assert.equal(code, 77);
  assert.match(stderr.text(), /Not allowed: /);
  assert.match(stderr.text(), /secrets_http_request/);
  assert.ok(vault.auditLog.some((e) => e.decision === 'deny'));
});

test('zn run refuses proxy-mode secrets, unknown secrets and agent-planted binaries', async (t) => {
  const vault = await setup();
  await vault.setSecret('GITHUB_TOKEN', GHP, { mode: 'proxy', allowHosts: ['api.github.com'], allowCommands: [NODE] });
  const e1 = sink();
  assert.equal(await runBroker(['--', NODE, '-e', '1', '__ZN_GITHUB_TOKEN__'], { vault, env: nodeEnv, stdout: sink(), stderr: e1, stdin: { isTTY: false } }), 77);
  assert.match(e1.text(), /proxy mode/);
  const e2 = sink();
  assert.equal(await runBroker(['--', NODE, '-e', '1', '__ZN_NOPE__'], { vault, env: nodeEnv, stdout: sink(), stderr: e2, stdin: { isTTY: false } }), 127);
  assert.match(e2.text(), /zn secret set NOPE/);

  const dir = tempDir(t, 'zn-plant-');
  const fakeBin = path.join(dir, process.platform === 'win32' ? 'psql.cmd' : 'psql');
  fs.writeFileSync(fakeBin, process.platform === 'win32' ? '@echo %*\r\n' : '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
  await vault.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: ['psql'] });
  const e3 = sink();
  const code = await runBroker(['--', 'psql', '__ZN_DB_PASSWORD__'], { vault, env: { PATH: dir }, stdout: sink(), stderr: e3, stdin: { isTTY: false } });
  assert.equal(code, 77);
  assert.match(e3.text(), /temp directory/);
});

test('first use is confirmed by the vault, never on the command terminal, and only once', async () => {
  const args = ['--', NODE, '-e', 'console.log(1)', '__ZN_DB_PASSWORD__'];
  let asked = 0;
  const vault = createFakeVault({ withApprovals: true, confirm: async () => { asked++; return true; } });
  await vault.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: [NODE] });
  // No terminal and an agent shell: the vault still asks the user on its own channel.
  const e0 = sink();
  assert.equal(await runBroker(args, { vault, env: { ...nodeEnv, CLAUDECODE: '1' }, stdout: sink(), stderr: e0, stdin: { isTTY: false } }), 0, e0.text());
  assert.match(e0.text(), /confirm it in the zn vault prompt/);
  assert.equal(await runBroker(args, { vault, env: nodeEnv, stdout: sink(), stderr: sink(), stdin: { isTTY: true } }), 0);
  assert.equal(asked, 1, 'asked only on first use');

  const declined = createFakeVault({ withApprovals: true, confirm: async () => false });
  await declined.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: [NODE] });
  const e2 = sink();
  // A local "yes" on the command's own terminal changes nothing.
  assert.equal(await runBroker(args, { vault: declined, env: nodeEnv, stdout: sink(), stderr: e2, stdin: { isTTY: true }, confirm: async () => true }), 77);
  assert.match(e2.text(), /was not approved \(declined by the user\)/);
  assert.ok(declined.auditLog.some((e) => e.decision === 'deny' && e.secret === 'DB_PASSWORD'));
});

test('a vault without approval calls never approves (no file fallback)', async (t) => {
  const znHome = tempDir(t, 'zn-appr-');
  const vault = createFakeVault();
  await vault.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: [NODE] });
  const args = ['--', NODE, '-e', '1', '__ZN_DB_PASSWORD__'];
  const e = sink();
  assert.equal(await runBroker(args, { vault, znHome, env: nodeEnv, stdout: sink(), stderr: e, stdin: { isTTY: true }, confirm: async () => true }), 77);
  assert.match(e.text(), /cannot record approvals/);
  assert.ok(!fs.existsSync(path.join(znHome, 'approvals.json')));
});

test('environment markers are optional: unrelated commands still run', async () => {
  const vault = await setup({ allowCommands: ['psql'] });
  const stdout = sink();
  const stderr = sink();
  const code = await runBroker(['--', NODE, '-e', 'console.log(process.env.DB_PASSWORD)'], {
    vault, env: { ...nodeEnv, DB_PASSWORD: '__ZN_DB_PASSWORD__' }, stdout, stderr, stdin: { isTTY: false },
  });
  assert.equal(code, 0);
  assert.equal(stdout.text().trim(), '__ZN_DB_PASSWORD__');
  assert.match(stderr.text(), /left as markers/);
});

test('without markers zn run is a plain pass-through and needs no vault', async () => {
  const stdout = sink();
  const code = await runBroker(['--', NODE, '-e', 'console.log("hi"); process.exit(3)'], { env: nodeEnv, stdout, stderr: sink() });
  assert.equal(code, 3);
  assert.equal(stdout.text().trim(), 'hi');
});

/* ---------------- batch files on Windows ---------------- */

const { systemCmdExe, batchInvocation } = require('../lib/broker/run');
const { spawnSync } = require('child_process');
const WIN = process.platform === 'win32';

test('the cmd.exe for batch files comes from the system, whatever SystemRoot, ComSpec or PATH say', () => {
  if (!WIN) { assert.equal(systemCmdExe(), null); return; }
  const real = systemCmdExe();
  assert.match(real, /^[A-Za-z]:\\[^%!"]+\\System32\\cmd\.exe$/i);
  const saved = { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATH: process.env.PATH };
  try {
    process.env.SystemRoot = 'Z:\\Windows';
    process.env.ComSpec = process.execPath;
    process.env.PATH = 'Z:\\Windows\\System32';
    assert.equal(systemCmdExe(), real);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('batch files: arguments zn changed, metacharacters and expansion characters in the path are refused', () => {
  const deny = (resolved, args, original) => assert.throws(() => batchInvocation(resolved, args, original),
    (e) => e.code === 'ZN_POLICY_DENIED', resolved + ' ' + args.join(' '));
  deny('C:\\tools\\deploy.cmd', ['secret-value'], ['__ZN_TOKEN__']);
  for (const a of ['a&b', 'a|b', 'a>b', 'a^b', '%PATH%', '!X!', 'a"b', 'a\nb']) deny('C:\\tools\\deploy.cmd', [a], [a]);
  for (const p of ['C:\\p\\%ZX%\\deploy.cmd', 'C:\\p\\!ZX!\\deploy.cmd', 'C:\\p\\a"b\\deploy.cmd']) deny(p, [], []);
});

test('a batch file runs through the system cmd.exe even when ComSpec points elsewhere', { skip: !WIN && 'Windows only' }, (t) => {
  const dir = tempDir(t, 'zn-bat-');
  const bat = path.join(dir, 'say hi.cmd');
  fs.writeFileSync(bat, '@echo off\r\necho ran:%~1:%~2\r\n');
  const b = batchInvocation(bat, ['one', 'two words'], ['one', 'two words']);
  assert.deepEqual(b.args.slice(0, 4), ['/d', '/v:off', '/s', '/c']);
  assert.match(b.file, /\\System32\\cmd\.exe$/i);
  // A hostile ComSpec in the environment of zn and of the child changes nothing.
  const env = { ...process.env, ComSpec: process.execPath };
  const r = spawnSync(b.file, b.args, { env, encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'ran:one:two words');
});

/* zn Team: the vault applies the organization policy in listSecrets({effective: true}). */
function withOrg(vault, fields) {
  const list = vault.listSecrets.bind(vault);
  vault.listSecrets = async (o) => (await list(o)).map((s) => (s.name === 'DB_PASSWORD' ? { ...s, ...fields } : s));
  return vault;
}

test('zn run: a warn rule lets the secret through, says so and records "warn"', async () => {
  const vault = withOrg(await setup(), { warn: true, warnReason: 'Database passwords need review' });
  const stdout = sink();
  const stderr = sink();
  const code = await runBroker(['--secrets', 'DB_PASSWORD', '--', NODE, '-e', 'console.log(process.env.DB_PASSWORD ? "set" : "unset")'], {
    vault, env: nodeEnv, stdout, stderr, stdin: { isTTY: false },
  });
  assert.equal(code, 0, stderr.text());
  assert.equal(stdout.text().trim(), 'set');
  assert.match(stderr.text(), /zn: your team policy would block DB_PASSWORD here \(policy note: "Database passwords need review"\)\. It was allowed and recorded for your organization\./);
  const uses = vault.auditLog.filter((e) => e.secret === 'DB_PASSWORD' && e.tool === 'zn run');
  assert.deepEqual(uses.map((e) => [e.decision, e.reason]), [['warn', 'policy:warn']]);
});

test('zn run: an organization deny still blocks', async () => {
  const vault = withOrg(await setup(), { deny: true, denyReason: 'policy:org_deny' });
  const stderr = sink();
  const code = await runBroker(['--secrets', 'DB_PASSWORD', '--', NODE, '-e', 'console.log(1)'], {
    vault, env: nodeEnv, stdout: sink(), stderr, stdin: { isTTY: false },
  });
  assert.equal(code, 77);
  assert.match(stderr.text(), /blocked for this agent by your organization policy/);
  assert.ok(vault.auditLog.some((e) => e.secret === 'DB_PASSWORD' && e.decision === 'deny'));
  assert.ok(!vault.auditLog.some((e) => e.decision === 'warn' || (e.secret === 'DB_PASSWORD' && e.decision === 'allow' && e.tool === 'zn run')));
});
