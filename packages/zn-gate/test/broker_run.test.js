'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');

const markers = require('../lib/broker/markers');
const { createMasker, variantsOf } = require('../lib/broker/mask');
const { runBroker, parseRunArgs } = require('../lib/broker/run');
const { createFakeVault } = require('./helpers/fake_vault');
const { generateAll } = require('./fixtures/fake_secrets');

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

test('zn run refuses a command outside allowCommands and points to secrets_http_request', async () => {
  const vault = await setup({ allowCommands: ['psql'] });
  const stderr = sink();
  const code = await runBroker(['--', NODE, '-e', 'console.log(process.argv[1])', '__ZN_DB_PASSWORD__'], { vault, env: nodeEnv, stdout: sink(), stderr, stdin: { isTTY: false } });
  assert.equal(code, 77);
  assert.match(stderr.text(), /ZN_POLICY_DENIED/);
  assert.match(stderr.text(), /secrets_http_request/);
  assert.ok(vault.auditLog.some((e) => e.decision === 'deny'));
});

test('zn run refuses proxy-mode secrets, unknown secrets and agent-planted binaries', async () => {
  const vault = await setup();
  await vault.setSecret('GITHUB_TOKEN', GHP, { mode: 'proxy', allowHosts: ['api.github.com'], allowCommands: [NODE] });
  const e1 = sink();
  assert.equal(await runBroker(['--', NODE, '-e', '1', '__ZN_GITHUB_TOKEN__'], { vault, env: nodeEnv, stdout: sink(), stderr: e1, stdin: { isTTY: false } }), 77);
  assert.match(e1.text(), /proxy mode/);
  const e2 = sink();
  assert.equal(await runBroker(['--', NODE, '-e', '1', '__ZN_NOPE__'], { vault, env: nodeEnv, stdout: sink(), stderr: e2, stdin: { isTTY: false } }), 127);
  assert.match(e2.text(), /zn secret set NOPE/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-plant-'));
  const fakeBin = path.join(dir, process.platform === 'win32' ? 'psql.cmd' : 'psql');
  fs.writeFileSync(fakeBin, process.platform === 'win32' ? '@echo %*\r\n' : '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
  await vault.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: ['psql'] });
  const e3 = sink();
  const code = await runBroker(['--', 'psql', '__ZN_DB_PASSWORD__'], { vault, env: { PATH: dir }, stdout: sink(), stderr: e3, stdin: { isTTY: false } });
  assert.equal(code, 77);
  assert.match(e3.text(), /temp directory/);
});

test('first use: without a terminal it is denied with the approve command; with one it asks once', async () => {
  const vault = await setup();
  const args = ['--', NODE, '-e', 'console.log(1)', '__ZN_DB_PASSWORD__'];
  const e1 = sink();
  assert.equal(await runBroker(args, { vault, env: nodeEnv, stdout: sink(), stderr: e1, stdin: { isTTY: false } }), 77);
  assert.match(e1.text(), /zn secret approve DB_PASSWORD --command "node"/);
  let asked = 0;
  const confirm = async () => { asked++; return true; };
  assert.equal(await runBroker(args, { vault, env: nodeEnv, stdout: sink(), stderr: sink(), stdin: { isTTY: true }, confirm }), 0);
  assert.equal(await runBroker(args, { vault, env: nodeEnv, stdout: sink(), stderr: sink(), stdin: { isTTY: true }, confirm }), 0);
  assert.equal(asked, 1, 'asked only on first use');
  const declined = await setup();
  const e2 = sink();
  assert.equal(await runBroker(args, { vault: declined, env: nodeEnv, stdout: sink(), stderr: e2, stdin: { isTTY: true }, confirm: async () => false }), 77);
  assert.match(e2.text(), /declined/);
  const agentShell = await setup();
  assert.equal(await runBroker(args, { vault: agentShell, env: { ...nodeEnv, CLAUDECODE: '1' }, stdout: sink(), stderr: sink(), stdin: { isTTY: true }, confirm }), 77, 'never prompts inside an agent shell');
});

test('file approval store is used when the vault has none', async () => {
  const znHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-appr-'));
  const vault = createFakeVault();
  await vault.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: [NODE] });
  const args = ['--', NODE, '-e', '1', '__ZN_DB_PASSWORD__'];
  assert.equal(await runBroker(args, { vault, znHome, env: nodeEnv, stdout: sink(), stderr: sink(), stdin: { isTTY: true }, confirm: async () => true }), 0);
  const data = JSON.parse(fs.readFileSync(path.join(znHome, 'approvals.json'), 'utf8'));
  assert.deepEqual(data.approvals.map((a) => [a.secret, a.command]), [['DB_PASSWORD', NODE]]);
  assert.ok(!fs.readFileSync(path.join(znHome, 'approvals.json'), 'utf8').includes(PG));
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
