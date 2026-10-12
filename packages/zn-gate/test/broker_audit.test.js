'use strict';
/* `zn audit` (the vault audit log) works with no vault, with a locked vault and with an unlocked one. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function zn(home, args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn') };
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 30000 });
}

test('zn audit with no vault lists nothing and does not crash', (t) => {
  const home = tempDir(t, 'zn-audit-');
  for (const args of [['audit'], ['audit', '--since', '1h']]) {
    const r = zn(home, args);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr + r.stdout, /argument must be|TypeError/);
    assert.match(r.stdout, /chain: not checked/);
  }
});

test('zn audit lists records of a locked vault and says the chain was not checked', (t) => {
  const home = tempDir(t, 'zn-audit-');
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  const rec = { seq: 1, ts: new Date().toISOString(), decision: 'allow', secret: 'DB_PASSWORD', mode: 'run', agent: 'claude-code', tool: 'Bash', prev: '0', mac: '00' };
  fs.writeFileSync(path.join(home, '.zn', 'audit.jsonl'), JSON.stringify(rec) + '\n');
  const r = zn(home, ['audit']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /DB_PASSWORD/);
  assert.match(r.stdout, /chain: not checked/);
});

test('zn audit checks the chain of an unlocked vault and exits 1 when it is broken', async (t) => {
  // Own cleanup (not tempDir): the daemon must stop before its home is removed.
  const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zn-audit-'));
  const env = { HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn'), ZN_KEYCHAIN_BACKEND: 'passphrase' };
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const daemon = require('../lib/vault/daemon');
  const clientMod = require('../lib/vault/client');
  const store = require('../lib/vault/store');
  let daemonPid = 0;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return false; } };
  t.after(async () => {
    try { await daemon.lock({}); } catch (err) { /* already locked */ }
    // lock() answers before the daemon finishes shutting down (it still writes the vault), so wait for the process.
    for (let i = 0; i < 100 && daemonPid && alive(daemonPid); i++) await new Promise((res) => setTimeout(res, 100));
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const unlocked = await daemon.unlock({ passphrase: 'correct horse battery staple', workFactor: 10 });
  daemonPid = (unlocked && unlocked.pid) || 0;
  const c = clientMod.createClient({});
  try {
    for (let i = 0; i < 3; i++) {
      await c.audit({ secret: 'DB_PASSWORD', mode: 'env', agent: 'claude-code', tool: 'Bash', argv0: 'psql', decision: 'allow' });
    }
  } finally { c.close(); }

  const file = store.paths({}).auditFile;
  const orig = fs.readFileSync(file, 'utf8');
  const lines = orig.trim().split('\n'); // unlock writes a record too
  let r = zn(home, ['audit']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('chain: valid, ' + lines.length + ' records'), r.stdout);

  const target = lines.findIndex((l) => l.includes('"secret":"DB_PASSWORD"'));
  const tampered = lines.slice();
  tampered[target] = tampered[target].replace('"decision":"allow"', '"decision":"deny"');
  fs.writeFileSync(file, tampered.join('\n') + '\n');
  r = zn(home, ['audit']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('chain: BROKEN: bad mac (record ' + (target + 1) + ')'), r.stdout);

  fs.writeFileSync(file, lines.slice(0, -1).join('\n') + '\n');
  r = zn(home, ['audit']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /chain: BROKEN: log truncated/);
});
