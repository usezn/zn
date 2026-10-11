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

async function startDaemon(extra) {
  srv = await daemon.serve(Object.assign({ identity, ttlMs: 60000, idleMs: 60000 }, extra || {}));
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
  assert.strictEqual(await c2.resolve('/work/app', t1), v1);
  assert.strictEqual(await c2.resolve('/work/other', t1), 'bob@example.org');
  assert.strictEqual(await c2.resolve('/work/app', '__ZN_EMAIL_42__'), null);
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

test('daemon: named secrets, reserved names, metadata updates, backups', async () => {
  const c = clientMod.createClient({});
  const value = 'ghp_' + fake(36);
  await c.setSecret('GITHUB_TOKEN', value, { mode: 'proxy', allowHosts: ['api.github.com', 'not a host!'], injectAt: 'header', bogus: 1 });
  for (const bad of ['AWS_KEY_1', 'REDACTED_EMAIL', 'lowercase', 'X'.repeat(80)]) {
    await assert.rejects(c.setSecret(bad, 'x'.repeat(12)), (e) => e.code === 'ZN_POLICY_DENIED', bad);
  }
  let list = await c.listSecrets();
  assert.deepStrictEqual(list.map((s) => s.name), ['GITHUB_TOKEN']);
  assert.deepStrictEqual(list[0].allowHosts, ['api.github.com']);
  assert.ok(!JSON.stringify(list).includes(value), 'listSecrets must never return values');
  await c.updateSecretMeta('GITHUB_TOKEN', { allowHosts: ['api.github.com', 'uploads.github.com'] });
  assert.strictEqual(await c.resolve('/work/app', '__ZN_GITHUB_TOKEN__'), value, 'meta update keeps the value');
  await assert.rejects(c.updateSecretMeta('MISSING', {}), (e) => e.code === 'ZN_NOT_FOUND');
  await c.setSecret('ENV_BACKUP_ABCDEF', 'A=1\nB=' + fake(20) + '\n', { mode: 'backup' });
  const exact = await c.exactValues('/work/app');
  assert.ok(exact.some((e) => e.name === 'GITHUB_TOKEN' && e.values[0] === value && e.values.length >= 4));
  assert.ok(!exact.some((e) => e.name === 'ENV_BACKUP_ABCDEF'), 'backups are not exact values');
  assert.ok(exact.some((e) => !e.name && e.type === 'EMAIL'), 'detected project values are exact values');
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
  const fake = path.join(shadow, POSIX ? 'node' : 'node.cmd');
  fs.writeFileSync(fake, POSIX ? '#!/bin/sh\nexit 0\n' : '@exit /b 0\r\n');
  if (POSIX) fs.chmodSync(fake, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = shadow + path.delimiter + savedPath;
  try {
    assert.strictEqual(await c.isApproved('/work/app', 'GITHUB_TOKEN', 'node'), false);
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(shadow, { recursive: true, force: true });
  }
  assert.strictEqual(await c.isApproved('/work/app', 'GITHUB_TOKEN', 'node'), true);
  // The broker's two-argument form: (secret, command), project from the cwd.
  assert.strictEqual(await c.isApproved('DEPLOY_KEY', 'node scripts/migrate.js'), false);
  await c.recordApproval('DEPLOY_KEY', 'node scripts/migrate.js');
  assert.strictEqual(await c.isApproved('DEPLOY_KEY', 'node'), true);
  c.close();
});

test('engine + real daemon: tokenize and detokenize through IPC', async () => {
  const c = clientMod.createClient({});
  const pw = fake(24);
  const ctx = { project: '/work/app', agent: 'test', tool: 'Read', destination: 'assistant', vault: c, env: {}, exactFiles: false };
  const text = 'GH=' + (await c.exactValues('/work/app')).find((e) => e.name === 'GITHUB_TOKEN').values[0] + '\nDB=postgres://app:' + pw + '@db:5432/app\n';
  const t = await engine.tokenize(text, ctx);
  assert.ok(t.text.includes('__ZN_GITHUB_TOKEN__') && t.text.includes('__ZN_DB_PASSWORD_1__'), t.text);
  assert.ok(!t.text.includes(pw));
  const back = await engine.detokenize(t.text, ctx);
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
  const value = (await c.exactValues('/work/app')).find((e) => e.name === 'GITHUB_TOKEN').values[0];
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

test('nothing in the vault directory holds a value in clear', () => {
  const dir = store.paths().vaultDir;
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'latin1');
    assert.ok(!/example\.org|ghp_|postgres/.test(text), f);
  }
});

run('vault').then(async () => {
  await stopDaemon().catch(() => {});
  clientMod.close();
  try { await daemon.lock({}); } catch (err) { /* ignore */ }
  fs.rmSync(HOME, { recursive: true, force: true });
});
