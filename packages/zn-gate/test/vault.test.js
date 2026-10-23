'use strict';
/**
 * Vault: age store, keychain backends, daemon, client, audit log.
 * Runs against a temporary ZN_HOME with the passphrase backend (low scrypt
 * work factor for speed). The OS keychain backends run only when
 * ZN_TEST_NATIVE_KEYCHAIN=1 (CI sets it on macOS and Windows).
 * Values are fake and generated at run time.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { test, run } = require('./_harness');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'znv-'));
process.env.ZN_HOME = HOME;
process.env.ZN_KEYCHAIN_BACKEND = 'passphrase';

const store = require('../lib/vault/store');
const keychain = require('../lib/vault/keychain');
const daemon = require('../lib/vault/daemon');
const clientMod = require('../lib/vault/client');
const audit = require('../lib/vault/audit');
const engine = require('../lib/scrub/engine');

const PASS = 'correct horse battery staple';
const WF = 10;
const POSIX = process.platform !== 'win32';
const fake = (n) => crypto.randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mode = (f) => fs.statSync(f).mode & 0o777;

let identity = null;
let srv = null;
let GH_VALUE = null;

// The daemon's out-of-band confirmation channel, answered by the test.
const confirmations = [];
let confirmAnswer = true;
async function testConfirm(req) { confirmations.push(req); return confirmAnswer; }

async function startDaemon(extra) {
  srv = await daemon.serve(Object.assign({ identity, ttlMs: 60000, idleMs: 60000, confirm: testConfirm }, extra || {}));
  return srv;
}
async function stopDaemon() {
  if (srv) { await srv.close(); srv = null; }
}

/* ---------------- store ---------------- */

test('store: project keys are stable, path-normalised and not reversible', () => {
  const a = store.projectKey('/work/app');
  assert.strictEqual(a, store.projectKey('/work/app/'));
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notStrictEqual(a, store.projectKey('/work/app2'));
  if (!POSIX) assert.strictEqual(store.projectKey('C:\\Work\\App'), store.projectKey('c:\\work\\app'));
});

test('store: encrypted JSON round-trip, atomic 0600 file, nothing in clear', async () => {
  const { identity: id, recipient } = await store.generateIdentity();
  const file = path.join(HOME, 'scratch', 'x.age');
  store.ensurePrivateDir(path.dirname(file));
  const secret = fake(24);
  await store.writeEncrypted(file, { secret }, recipient);
  assert.ok(!fs.readFileSync(file).toString('latin1').includes(secret));
  assert.ok(fs.readFileSync(file).toString('latin1').startsWith('age-encryption.org/v1'));
  assert.deepStrictEqual(await store.readEncrypted(file, id), { secret });
  if (POSIX) {
    assert.strictEqual(mode(file), 0o600);
    assert.strictEqual(mode(path.dirname(file)), 0o700);
  }
  const other = await store.generateIdentity();
  await assert.rejects(store.readEncrypted(file, other.identity));
  assert.ok(!fs.readdirSync(path.dirname(file)).some((n) => n.endsWith('.tmp')));
});

test('store: symlinked vault files are refused (POSIX)', async () => {
  if (!POSIX) return;
  const target = path.join(HOME, 'scratch', 'target');
  fs.writeFileSync(target, 'x');
  const link = path.join(HOME, 'scratch', 'link.age');
  fs.symlinkSync(target, link);
  assert.throws(() => store.readPrivateFile(link), (e) => e.code === 'ZN_POLICY_DENIED');
});

/* ---------------- keychain (passphrase) ---------------- */

test('keychain: passphrase backend creates, loads and rejects a wrong passphrase', async () => {
  await assert.rejects(keychain.initIdentity({ passphrase: 'short' }), (e) => e.code === 'ZN_POLICY_DENIED');
  const created = await keychain.initIdentity({ passphrase: PASS, workFactor: WF });
  assert.strictEqual(created.backend, 'passphrase');
  identity = created.identity;
  assert.strictEqual(await keychain.loadIdentity({ passphrase: PASS }), identity);
  await assert.rejects(keychain.loadIdentity({ passphrase: 'not the passphrase at all' }), (e) => e.code === 'ZN_LOCKED');
  await assert.rejects(keychain.initIdentity({ passphrase: PASS, workFactor: WF }), (e) => e.code === 'ZN_POLICY_DENIED');
  const idFile = store.paths().identityFile;
  assert.ok(!fs.readFileSync(idFile, 'latin1').includes(identity));
  if (POSIX) assert.strictEqual(mode(idFile), 0o600);
});

test('keychain: an identity that does not match the vault is refused', async () => {
  const meta = JSON.parse(fs.readFileSync(store.paths().metaFile, 'utf8'));
  const other = await store.generateIdentity();
  fs.writeFileSync(store.paths().metaFile, JSON.stringify(Object.assign({}, meta, { recipient: other.recipient })));
  await assert.rejects(keychain.loadIdentity({ passphrase: PASS }), (e) => e.code === 'ZN_LOCKED');
  fs.writeFileSync(store.paths().metaFile, JSON.stringify(meta));
});

test('keychain: native OS backend (opt-in)', async () => {
  if (process.env.ZN_TEST_NATIVE_KEYCHAIN !== '1') { console.log('       (skipped: set ZN_TEST_NATIVE_KEYCHAIN=1)'); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'znk-'));
  const saved = process.env.ZN_KEYCHAIN_BACKEND;
  delete process.env.ZN_KEYCHAIN_BACKEND;
  process.env.ZN_KEYCHAIN_SERVICE = 'zn-vault-test-' + crypto.randomBytes(4).toString('hex');
  try {
    const backend = keychain.detectBackend();
    assert.ok(['macos', 'windows', 'libsecret'].includes(backend), 'no native backend here: ' + backend);
    const r = await keychain.initIdentity({ home });
    assert.strictEqual(await keychain.loadIdentity({ home }), r.identity);
    await keychain.deleteIdentity({ home });
    assert.strictEqual(keychain._native[backend].load(), null);
  } finally {
    process.env.ZN_KEYCHAIN_BACKEND = saved;
    delete process.env.ZN_KEYCHAIN_SERVICE;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* ---------------- daemon + client ---------------- */

test('client: no daemon -> ZN_LOCKED', async () => {
  const c = clientMod.createClient({});
  await assert.rejects(c.status(), (e) => e.code === 'ZN_LOCKED');
  c.close();
});

test('daemon: socket and session key are private', async () => {
  await startDaemon();
  const ep = clientMod.endpoint({});
  assert.ok(fs.existsSync(ep.keyFile));
  if (POSIX) {
    assert.strictEqual(mode(ep.address), 0o600);
    assert.strictEqual(mode(ep.keyFile), 0o600);
    assert.strictEqual(mode(store.paths().runDir), 0o700);
  }
});

test('daemon: tokens are deterministic per project and survive a restart', async () => {
  const c = clientMod.createClient({});
  const v1 = 'alice.' + fake(6).toLowerCase() + '@example.org';
  const t1 = await c.mapToken('/work/app', 'EMAIL', v1);
  assert.strictEqual(t1, '__ZN_EMAIL_1__');
  assert.strictEqual(await c.mapToken('/work/app', 'EMAIL', v1), t1);
  assert.strictEqual(await c.mapToken('/work/app', 'EMAIL', 'bob@example.org'), '__ZN_EMAIL_2__');
  assert.strictEqual(await c.mapToken('/work/other', 'EMAIL', 'bob@example.org'), '__ZN_EMAIL_1__');
  c.close();
  await stopDaemon();
  await startDaemon();
  const c2 = clientMod.createClient({});
  assert.strictEqual(await c2.mapToken('/work/app', 'EMAIL', v1), t1);
  assert.strictEqual(await c2.resolve('/work/app', t1, { destination: 'write_ignored' }), v1);
  assert.strictEqual(await c2.resolve('/work/other', t1, { destination: 'write_ignored' }), 'bob@example.org');
  assert.strictEqual(await c2.resolve('/work/app', '__ZN_EMAIL_42__', { destination: 'write_ignored' }), null);
  c2.close();
});

test('daemon: concurrent mapToken calls get distinct, stable ordinals', async () => {
  const clients = [0, 1, 2].map(() => clientMod.createClient({}));
  const values = Array.from({ length: 12 }, (_, i) => 'user' + i + '.' + fake(4).toLowerCase() + '@example.org');
  const tokens = await Promise.all(values.map((v, i) => clients[i % 3].mapToken('/work/concurrent', 'EMAIL', v)));
  assert.strictEqual(new Set(tokens).size, values.length);
  const again = await Promise.all(values.map((v) => clients[0].mapToken('/work/concurrent', 'EMAIL', v)));
  assert.deepStrictEqual(again, tokens);
  clients.forEach((c) => c.close());
});

test('daemon: resolve refuses withheld destinations and audits it', async () => {
  const c = clientMod.createClient({});
  for (const d of ['bash_network', 'mcp_input', 'write_tracked']) {
    await assert.rejects(c.resolve('/work/app', '__ZN_EMAIL_1__', { destination: d }), (e) => e.code === 'ZN_POLICY_DENIED', d);
  }
  assert.ok(await c.resolve('/work/app', '__ZN_EMAIL_1__', { destination: 'bash_local' }));
  c.close();
});

test('daemon: the zn cloud key is refused to hooks, the broker and zn run', async () => {
  const c = clientMod.createClient({});
  const value = 'zn_' + crypto.randomBytes(24).toString('hex');
  await c.setSecret('ZN_CLOUD_API_KEY', value, { mode: 'proxy', allowHosts: ['api.usezn.com'] });
  const marker = '__ZN_ZN_CLOUD_API_KEY__';
  await assert.rejects(c.resolve('/work/app', marker), (e) => e.code === 'ZN_POLICY_DENIED');
  await assert.rejects(c.resolve('/work/app', marker, { destination: 'bash_local', agent: 'claude-code', tool: 'Bash' }), (e) => e.code === 'ZN_POLICY_DENIED');
  const quiet = await c.resolve('/work/app', marker, { destination: 'write_local', withPolicy: true });
  assert.strictEqual(quiet.value, null);
  assert.strictEqual(await c.resolve('/work/app', marker, { purpose: 'zn-cloud-key' }), value);
  assert.strictEqual(await c.resolve('/work/app', marker, { purpose: 'something-else' }).catch(() => 'denied'), 'denied');
  await c.removeSecret('ZN_CLOUD_API_KEY');
  c.close();
});

test('daemon: named secrets, reserved names, metadata updates, backups', async () => {
  const c = clientMod.createClient({});
  const value = 'ghp_' + fake(36);
  await c.setSecret('GITHUB_TOKEN', value, { mode: 'env', allowHosts: ['api.github.com', 'not a host!'], injectAt: 'header', bogus: 1 });
  GH_VALUE = value;
  for (const bad of ['AWS_KEY_1', 'REDACTED_EMAIL', 'lowercase', 'X'.repeat(80)]) {
    await assert.rejects(c.setSecret(bad, 'x'.repeat(12)), (e) => e.code === 'ZN_POLICY_DENIED', bad);
  }
  let list = await c.listSecrets();
  assert.deepStrictEqual(list.map((s) => s.name), ['GITHUB_TOKEN']);
  assert.deepStrictEqual(list[0].allowHosts, ['api.github.com']);
  assert.ok(!JSON.stringify(list).includes(value), 'listSecrets must never return values');
  await c.updateSecretMeta('GITHUB_TOKEN', { allowHosts: ['api.github.com', 'uploads.github.com'] });
  assert.strictEqual(await c.resolve('/work/app', '__ZN_GITHUB_TOKEN__', { destination: 'write_ignored' }), value, 'meta update keeps the value');
  await assert.rejects(c.updateSecretMeta('MISSING', {}), (e) => e.code === 'ZN_NOT_FOUND');
  const backupText = 'A=1\nB=' + fake(20) + '\n';
  await c.setSecret('ENV_BACKUP_ABCDEF', backupText, { mode: 'backup' });
  // The daemon matches; no call hands out a value, an encoding of one or a hash.
  const info = await c.maskInfo('/work/app');
  assert.ok(info.names.includes('GITHUB_TOKEN') && info.longest >= value.length && info.count >= 4);
  assert.ok(!info.names.includes('ENV_BACKUP_ABCDEF'), 'backups are not looked for');
  assert.ok(!JSON.stringify(info).includes(value));
  const [found, backupFound, detectedFound] = await c.maskSpans('/work/app', ['x ' + value + ' y', backupText, 'to bob@example.org now']);
  assert.ok(found.some((s) => s.name === 'GITHUB_TOKEN' && s.variant === 'raw' && s.start === 2 && s.end === 2 + value.length && s.vault === true));
  assert.ok(found.every((s) => !('value' in s) && !('values' in s)));
  assert.deepStrictEqual(backupFound, [], 'backups are not exact values');
  assert.ok(detectedFound.some((s) => !s.name && s.type === 'EMAIL'), 'detected project values are matched too');
  await assert.rejects(c.call('exactValues', ['/work/app', { purpose: 'mask' }]), (e) => e.code === 'ZN_POLICY_DENIED' && /unknown operation/.test(e.message));
  assert.strictEqual(await c.removeSecret('ENV_BACKUP_ABCDEF'), true);
  assert.strictEqual(await c.removeSecret('ENV_BACKUP_ABCDEF'), false);
  list = await c.listSecrets();
  assert.deepStrictEqual(list.map((s) => s.name), ['GITHUB_TOKEN']);
  c.close();
});

test('daemon: first-use approvals are per (project, secret, real executable)', async () => {
  const c = clientMod.createClient({});
  assert.ok(clientMod.resolveExecutable('node'), 'node must be on PATH for this test');
  assert.strictEqual(await c.isApproved('/work/app', 'GITHUB_TOKEN', 'node'), false);
  await c.recordApproval('/work/app', 'GITHUB_TOKEN', 'node');
  assert.strictEqual(await c.isApproved('/work/app', 'GITHUB_TOKEN', 'node'), true);
  assert.strictEqual(await c.isApproved('/work/other', 'GITHUB_TOKEN', 'node'), false);
  assert.strictEqual(await c.isApproved('/work/app', 'OTHER_SECRET', 'node'), false);
  await assert.rejects(c.recordApproval('/work/app', 'GITHUB_TOKEN', 'zn-no-such-command-xyz'), (e) => e.code === 'ZN_NOT_FOUND');
  await assert.rejects(c.recordApproval('/work/app', 'GITHUB_TOKEN', 'gh; rm -rf /'), (e) => e.code === 'ZN_POLICY_DENIED' || e.code === 'ZN_NOT_FOUND');
  // A binary with the same name earlier on PATH: the approval no longer applies.
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-shadow-'));
  const savedPath = process.env.PATH;
  try {
    const fake = path.join(shadow, POSIX ? 'node' : 'node.cmd');
    fs.writeFileSync(fake, POSIX ? '#!/bin/sh\nexit 0\n' : '@exit /b 0\r\n');
    if (POSIX) fs.chmodSync(fake, 0o755);
    process.env.PATH = shadow + path.delimiter + savedPath;
    assert.strictEqual(await c.isApproved('/work/app', 'GITHUB_TOKEN', 'node'), false);
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(shadow, { recursive: true, force: true });
  }
  assert.strictEqual(await c.isApproved('/work/app', 'GITHUB_TOKEN', 'node'), true);
  // The broker's two-argument form: (secret, command), project from the cwd.
  await c.setSecret('DEPLOY_KEY', crypto.randomBytes(16).toString('hex'), { mode: 'env', allowCommands: ['node scripts/migrate.js'] });
  assert.strictEqual(await c.isApproved('DEPLOY_KEY', 'node scripts/migrate.js'), false);
  await c.recordApproval('DEPLOY_KEY', 'node scripts/migrate.js');
  assert.strictEqual(await c.isApproved('DEPLOY_KEY', 'node'), true);
  c.close();
});

test('daemon: approvals and policy widening are confirmed out of band', async () => {
  const c = clientMod.createClient({});
  // Each recordApproval asked the channel and showed the real executable.
  const asked = confirmations.filter((r) => r.kind === 'approval');
  assert.ok(asked.length >= 2);
  assert.ok(asked.every((r) => r.message.includes(clientMod.resolveExecutable('node'))), 'the prompt names the real executable');
  assert.ok(asked.some((r) => /runs any code/.test(r.message)), 'interpreters carry a warning');
  // Declined: nothing is recorded.
  confirmAnswer = false;
  await assert.rejects(c.recordApproval('/work/declined', 'GITHUB_TOKEN', 'node'), (e) => e.code === 'ZN_POLICY_DENIED' && /declined/.test(e.message));
  assert.strictEqual(await c.isApproved('/work/declined', 'GITHUB_TOKEN', 'node'), false);
  await assert.rejects(c.updateSecretMeta('GITHUB_TOKEN', { allowHosts: ['api.github.com', 'evil.example'] }), (e) => e.code === 'ZN_POLICY_DENIED');
  assert.ok(!(await c.listSecrets()).find((s) => s.name === 'GITHUB_TOKEN').allowHosts.includes('evil.example'));
  // Narrowing needs no confirmation.
  const n0 = confirmations.length;
  await c.updateSecretMeta('GITHUB_TOKEN', { allowHosts: ['api.github.com'] });
  assert.strictEqual(confirmations.length, n0);
  confirmAnswer = true;
  await c.updateSecretMeta('GITHUB_TOKEN', { allowIn: ['header', 'body'] });
  const last = confirmations[confirmations.length - 1];
  assert.strictEqual(last.kind, 'policy');
  assert.match(last.message, /HTTP placement \+ body/);
  assert.deepStrictEqual((await c.listSecrets()).find((s) => s.name === 'GITHUB_TOKEN').allowIn, ['header', 'body']);
  await c.updateSecretMeta('GITHUB_TOKEN', { allowIn: ['header'] });
  c.close();
  // No channel at all: refused with guidance, and audited.
  await stopDaemon();
  await startDaemon({ confirm: undefined });
  const c2 = clientMod.createClient({});
  assert.strictEqual((await c2.status()).confirm, 'none');
  await assert.rejects(c2.recordApproval('/work/nochan', 'GITHUB_TOKEN', 'node'), (e) => e.code === 'ZN_POLICY_DENIED' && /--foreground/.test(e.message));
  c2.close();
  await stopDaemon();
  await startDaemon();
});

test('daemon: an approved executable rewritten in place loses its approval', async () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.zn-test-bin-'));
  const saved = process.env.PATH;
  let c = null;
  try {
    const bin = path.join(dir, POSIX ? 'zn-fp-tool' : 'zn-fp-tool.cmd');
    fs.writeFileSync(bin, POSIX ? '#!/bin/sh\nexit 0\n' : '@exit /b 0\r\n');
    if (POSIX) fs.chmodSync(bin, 0o755);
    process.env.PATH = dir + path.delimiter + saved;
    c = clientMod.createClient({});
    await c.recordApproval('/work/fp', 'GITHUB_TOKEN', 'zn-fp-tool');
    assert.strictEqual(await c.isApproved('/work/fp', 'GITHUB_TOKEN', 'zn-fp-tool'), true);
    await sleep(20);
    fs.appendFileSync(bin, POSIX ? 'echo planted\n' : 'echo planted\r\n');
    assert.strictEqual(await c.isApproved('/work/fp', 'GITHUB_TOKEN', 'zn-fp-tool'), false, 'content change must void the approval');
  } finally {
    process.env.PATH = saved;
    if (c) c.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon: re-approval says the program changed; the opened file must match', async () => {
  const exe = require('../lib/exe');
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.zn-test-bin2-'));
  let c = null;
  try {
    const bin = path.join(dir, POSIX ? 'zn-chg-tool' : 'zn-chg-tool.cmd');
    fs.writeFileSync(bin, POSIX ? '#!/bin/sh\nexit 0\n' : '@exit /b 0\r\n');
    if (POSIX) fs.chmodSync(bin, 0o755);
    const real = fs.realpathSync(bin);
    c = clientMod.createClient({});
    confirmAnswer = true;
    const fp1 = exe.fingerprint(real);
    await c.recordApproval('/work/chg', 'GITHUB_TOKEN', 'zn-chg-tool', { real, fp: fp1 });
    const first = confirmations[confirmations.length - 1];
    assert.ok(!first.changed && !/CHANGED/.test(first.title));
    assert.ok(/Writable by you/.test(first.message), 'a program in a user-writable place carries a warning');
    assert.strictEqual(await c.isApproved('/work/chg', 'GITHUB_TOKEN', 'zn-chg-tool', { real, fp: fp1 }), true);
    assert.strictEqual(await c.isApproved('/work/chg', 'GITHUB_TOKEN', 'zn-chg-tool', { real, fp: '1:2:3:4' }), false, 'a different opened file is refused');
    await sleep(20);
    fs.appendFileSync(bin, POSIX ? 'echo changed\n' : 'echo changed\r\n');
    const fp2 = exe.fingerprint(real);
    assert.strictEqual(await c.isApproved('/work/chg', 'GITHUB_TOKEN', 'zn-chg-tool', { real, fp: fp2 }), false);
    await c.recordApproval('/work/chg', 'GITHUB_TOKEN', 'zn-chg-tool', { real, fp: fp2 });
    const again = confirmations[confirmations.length - 1];
    assert.ok(again.changed && /CHANGED since you approved it/.test(again.title), again.title);
    assert.match(again.message, /Approved: .*bytes, changed/);
    assert.match(again.message, /Now: .*bytes, changed/);
    // Interpreter names with versions are recognised.
    assert.strictEqual(exe.isInterpreter('python3.12'), true);
    assert.strictEqual(exe.isInterpreter('node22'), true);
    assert.strictEqual(exe.isInterpreter('psql'), false);
    for (const name of ['pythonw', 'python3.12m', 'python3.13t', 'R', 'Rscript', 'groovy', 'jshell', 'deno', 'bun', 'php', 'lua', 'osascript']) {
      assert.strictEqual(exe.isInterpreter(name), true, name);
    }
    // The resolved program decides too: a renamed copy of an interpreter, and paths with spaces.
    assert.strictEqual(exe.isInterpreterPath('/opt/My Tools/python3.12'), true);
    assert.strictEqual(exe.isInterpreterPath('C:\\Program Files\\Python312\\python3.12.exe'), true);
    assert.strictEqual(exe.isInterpreterPath('/usr/local/bin/psql'), false);
    // Dialog text: client-supplied fields cannot add lines.
    const confirm = require('../lib/vault/confirm');
    const text = confirm.render({ warnings: ['W'], fields: [['Runs', '/a\nRuns: /b‮']], footer: 'F' });
    assert.strictEqual(text.split('\n').length, 3);
    assert.ok(!text.includes('‮'));
  } finally {
    if (c) c.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon: writing secret values to a file outside the safe case is confirmed', async () => {
  const c = clientMod.createClient({});
  const file = path.join(HOME, 'outside', 'x.rc');
  confirmAnswer = false;
  await assert.rejects(c.confirmFileWrite('/work/app', file, ['GITHUB_TOKEN'], 'the file is outside the project'), (e) => e.code === 'ZN_POLICY_DENIED');
  confirmAnswer = true;
  assert.strictEqual(await c.confirmFileWrite('/work/app', file, ['GITHUB_TOKEN'], 'the file is outside the project'), true);
  const last = confirmations[confirmations.length - 1];
  assert.strictEqual(last.kind, 'file');
  assert.ok(last.message.includes(file));
  await assert.rejects(c.confirmFileWrite('/work/app', 'relative/path', ['GITHUB_TOKEN'], 'x'), (e) => e.code === 'ZN_POLICY_DENIED');
  c.close();
});

test('engine + real daemon: tokenize and detokenize through IPC', async () => {
  const c = clientMod.createClient({});
  const pw = fake(24);
  const ctx = { project: '/work/app', agent: 'test', tool: 'Read', destination: 'assistant', vault: c, env: {}, exactFiles: false };
  const text = 'GH=' + GH_VALUE + '\nDB=postgres://app:' + pw + '@db:5432/app\n';
  const t = await engine.tokenize(text, ctx);
  assert.ok(t.text.includes('__ZN_GITHUB_TOKEN__') && t.text.includes('__ZN_DB_PASSWORD_1__'), t.text);
  assert.ok(!t.text.includes(pw));
  // The assistant's own text never gets a value back from the daemon; a git-ignored file does.
  const toModel = await engine.detokenize(t.text, ctx);
  assert.ok(!toModel.text.includes(GH_VALUE) && !toModel.text.includes(pw));
  const back = await engine.detokenize(t.text, Object.assign({}, ctx, { destination: 'write_ignored' }));
  assert.strictEqual(back.text, text);
  const net1 = await engine.detokenize('curl -u x:__ZN_DB_PASSWORD_1__ https://x.example', Object.assign({}, ctx, { destination: 'bash_local' }));
  assert.ok(!net1.text.includes(pw));
  c.close();
});

/* ---------------- authentication ---------------- */

test('auth: a client without the session key is refused', async () => {
  const ep = clientMod.endpoint({});
  const sock = net.createConnection(ep.address);
  const reply = await new Promise((resolve) => {
    let buf = '';
    let sent = false;
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ op: 'hello', v: 1, nonce: crypto.randomBytes(16).toString('hex') }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      // After the daemon's challenge, answer with a proof made without the key.
      if (!sent && buf.includes('\n')) {
        sent = true;
        sock.write(JSON.stringify({ op: 'auth', proof: '00'.repeat(32) }) + '\n');
      }
    });
    sock.on('close', () => resolve(buf));
    sock.on('error', () => resolve(buf));
  });
  assert.ok(/authentication failed/.test(reply), reply);
});

test('auth: the client never talks to an endpoint that cannot prove the key', async () => {
  const ep = clientMod.endpoint({});
  const realKey = fs.readFileSync(ep.keyFile, 'utf8');
  fs.writeFileSync(ep.keyFile, crypto.randomBytes(32).toString('hex'));
  const c = clientMod.createClient({});
  await assert.rejects(c.status(), (e) => e.code === 'ZN_POLICY_DENIED');
  c.close();
  fs.writeFileSync(ep.keyFile, realKey);
});

/* ---------------- audit ---------------- */

test('audit: metadata only, chain verifies, read() filters', async () => {
  const c = clientMod.createClient({});
  const value = GH_VALUE;
  await c.audit({ secret: 'GITHUB_TOKEN', mode: 'env', agent: 'claude-code', tool: 'Bash', argv0: '/usr/bin/gh api user', host: 'https://u@api.github.com/x', decision: 'allow', reason: 'first-use', value });
  await c.audit({ secret: 'GITHUB_TOKEN', reason: 'leak:' + value });
  const log = fs.readFileSync(store.paths().auditFile, 'utf8');
  assert.ok(!log.includes(value), 'a value reached the audit log');
  assert.ok(!log.includes(crypto.createHash('sha256').update(value).digest('hex')), 'a hash of a value reached the audit log');
  const last = audit.read({ limit: 2 });
  assert.strictEqual(last[0].argv0, 'gh');
  assert.strictEqual(last[0].host, 'api.github.com');
  assert.strictEqual(last[1].reason, '[redacted]');
  assert.deepStrictEqual(audit.read({ since: '1h' }).length > 2, true);
  assert.deepStrictEqual(await c.auditVerify(), { ok: true, records: log.trim().split('\n').length });
  if (POSIX) assert.strictEqual(mode(store.paths().auditFile), 0o600);
  c.close();
});

test('audit: edits and truncation are detected', async () => {
  const c = clientMod.createClient({});
  const file = store.paths().auditFile;
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.trim().split('\n');
  const edited = lines.slice();
  edited[1] = edited[1].replace('"decision":"', '"decision":"x');
  fs.writeFileSync(file, edited.join('\n') + '\n');
  assert.strictEqual((await c.auditVerify()).ok, false);
  fs.writeFileSync(file, lines.slice(0, -2).join('\n') + '\n');
  const trunc = await c.auditVerify();
  assert.strictEqual(trunc.ok, false);
  assert.match(trunc.error, /truncated/);
  fs.writeFileSync(file, original);
  assert.strictEqual((await c.auditVerify()).ok, true);
  c.close();
});

/* ---------------- lifecycle ---------------- */

test('lifecycle: idle expiry drops the session', async () => {
  await stopDaemon();
  let reason = null;
  await startDaemon({ idleMs: 400, onExit: (r) => { reason = r; } });
  const c = clientMod.createClient({});
  await c.status();
  c.close();
  await sleep(900);
  assert.strictEqual(reason, 'idle');
  assert.ok(!fs.existsSync(clientMod.endpoint({}).keyFile), 'session key must be removed');
  const c2 = clientMod.createClient({});
  await assert.rejects(c2.status(), (e) => e.code === 'ZN_LOCKED');
  c2.close();
  srv = null;
});

test('lifecycle: a slow start does not use up the idle time before the first client', async () => {
  await stopDaemon();
  // Simulate a slow disk: the unlock audit write blocks the loop for longer
  // than the idle time, so the idle timer is already due when serve() returns.
  const realAppend = audit.append;
  audit.append = function () {
    const end = Date.now() + 700;
    while (Date.now() < end) { /* busy wait */ }
    return realAppend.apply(this, arguments);
  };
  let reason = null;
  try { await startDaemon({ idleMs: 400, onExit: (r) => { reason = r; } }); } finally { audit.append = realAppend; }
  const c = clientMod.createClient({});
  const st = await c.status();
  assert.strictEqual(st.unlocked, true);
  assert.strictEqual(reason, null);
  c.close();
  await stopDaemon();
});

test('lifecycle: zn unlock spawns a detached daemon; zn lock stops it', async () => {
  const u = await daemon.unlock({ passphrase: PASS });
  assert.ok(u.pid > 0 && !u.created);
  await assert.rejects(daemon.unlock({ passphrase: PASS }), (e) => e.code === 'ZN_POLICY_DENIED');
  const c = clientMod.createClient({});
  assert.strictEqual(await c.mapToken('/work/app', 'EMAIL', 'bob@example.org'), '__ZN_EMAIL_2__');
  c.close();
  assert.strictEqual(await daemon.lock({}), true);
  await sleep(200);
  assert.strictEqual(await daemon.lock({}), false);
  await assert.rejects(daemon.unlock({ passphrase: 'not the passphrase at all' }), (e) => e.code === 'ZN_LOCKED');
});

test('vault files: forged, corrupted or missing secrets.age fail closed with a clear message', async () => {
  await stopDaemon();
  const p = store.paths();
  const original = fs.readFileSync(p.secretsFile);
  const meta = keychain.readMeta({});
  try {
    // A vault encrypted to the public recipient by someone else.
    const forged = await store.encryptTo(meta.recipient, JSON.stringify({ v: 1, auditKey: 'a'.repeat(64), secrets: {}, approvals: {} }));
    fs.writeFileSync(p.secretsFile, Buffer.from(forged));
    await assert.rejects(startDaemon(), (e) => e.code === 'ZN_LOCKED' && /integrity check/.test(e.message));
    // Garbage.
    fs.writeFileSync(p.secretsFile, 'not an age file');
    await assert.rejects(startDaemon(), (e) => e.code === 'ZN_LOCKED' && /secrets\.age is corrupted or was encrypted to another key/.test(e.message));
    // Deleted while the audit log and project maps exist.
    fs.unlinkSync(p.secretsFile);
    await assert.rejects(startDaemon(), (e) => e.code === 'ZN_LOCKED' && /missing but this vault has history/.test(e.message));
    assert.ok(!fs.existsSync(p.secretsFile), 'no empty vault was created');
    // keychain.json broken.
    const metaRaw = fs.readFileSync(p.metaFile);
    fs.writeFileSync(p.metaFile, '{broken');
    assert.throws(() => keychain.readMeta({}), (e) => e.code === 'ZN_LOCKED' && /keychain\.json is corrupted/.test(e.message));
    fs.writeFileSync(p.metaFile, metaRaw);
  } finally {
    fs.writeFileSync(p.secretsFile, original);
    if (POSIX) fs.chmodSync(p.secretsFile, 0o600);
  }
  await startDaemon();
  await stopDaemon();
});

test('nothing in the vault directory holds a value in clear', () => {
  const dir = store.paths().vaultDir;
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'latin1');
    assert.ok(!/example\.org|ghp_|postgres/.test(text), f);
  }
});

run('vault').finally(async () => {
  // Stop every daemon before the temporary ZN_HOME is removed, whatever happened above.
  try {
    await stopDaemon().catch(() => {});
    clientMod.close();
    try { await daemon.lock({}); } catch (err) { /* ignore */ }
  } finally {
    fs.rmSync(HOME, { recursive: true, force: true });
  }
});
