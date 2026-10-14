'use strict';
/*
 * The vault audit log (`zn vault log`, `zn secret log`)
 * works with no vault, with a locked vault and with an unlocked one.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

const LOG_COMMANDS = [['vault', 'log'], ['secret', 'log']];

/** The log commands print nothing about `zn audit` on stderr. */
function assertNotice(cmd, r) {
  assert.doesNotMatch(r.stderr, /zn audit/, r.stderr);
}

function zn(home, args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn') };
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 30000 });
}

test('the log with no vault lists nothing and does not crash', (t) => {
  const home = tempDir(t, 'zn-audit-');
  for (const cmd of LOG_COMMANDS) {
    for (const extra of [[], ['--since', '1h']]) {
      const r = zn(home, [...cmd, ...extra]);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr + r.stdout, /argument must be|TypeError/);
      assert.match(r.stdout, /chain: not checked/);
      assertNotice(cmd, r);
    }
  }
});

test('zn secret log prints the same as zn vault log; zn audit --since and zn audit log point to it', (t) => {
  const home = tempDir(t, 'zn-audit-');
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  const rec = { seq: 1, ts: new Date().toISOString(), decision: 'allow', secret: 'DB_PASSWORD', mode: 'run', agent: 'claude-code', tool: 'Bash', prev: '0', mac: '00' };
  fs.writeFileSync(path.join(home, '.zn', 'audit.jsonl'), JSON.stringify(rec) + '\n');
  const v = zn(home, ['vault', 'log']);
  const s = zn(home, ['secret', 'log']);
  assert.strictEqual(s.stdout, v.stdout);
  assert.strictEqual(v.stderr, '');
  assert.strictEqual(s.stderr, '');
  // `zn audit` reviews agent configs now; the old log forms are a usage error with a pointer.
  for (const args of [['audit', '--since', '1h'], ['audit', 'log']]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn') }, encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /zn vault log/);
    assert.doesNotMatch(r.stdout, /DB_PASSWORD/);
  }
});

test('--since filters the log in both commands', (t) => {
  const home = tempDir(t, 'zn-audit-');
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  const old = { seq: 1, ts: new Date(Date.now() - 3 * 3600000).toISOString(), decision: 'allow', secret: 'OLD_SECRET', mode: 'run', agent: 'claude-code', tool: 'Bash', prev: '0', mac: '00' };
  const recent = { seq: 2, ts: new Date().toISOString(), decision: 'allow', secret: 'NEW_SECRET', mode: 'run', agent: 'claude-code', tool: 'Bash', prev: '0', mac: '00' };
  fs.writeFileSync(path.join(home, '.zn', 'audit.jsonl'), JSON.stringify(old) + '\n' + JSON.stringify(recent) + '\n');
  for (const cmd of LOG_COMMANDS) {
    const all = zn(home, cmd);
    assert.match(all.stdout, /OLD_SECRET/);
    assert.match(all.stdout, /NEW_SECRET/);
    const r = zn(home, [...cmd, '--since', '1h']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /OLD_SECRET/);
    assert.match(r.stdout, /NEW_SECRET/);
    assertNotice(cmd, r);
  }
});

test('zn vault with an unknown subcommand still prints the usage with zn vault log', (t) => {
  const home = tempDir(t, 'zn-audit-');
  const r = zn(home, ['vault', 'nope']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /zn vault log \[--since 1h\]/);
});

test('the log lists records of a locked vault and says the chain was not checked', (t) => {
  const home = tempDir(t, 'zn-audit-');
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  const rec = { seq: 1, ts: new Date().toISOString(), decision: 'allow', secret: 'DB_PASSWORD', mode: 'run', agent: 'claude-code', tool: 'Bash', prev: '0', mac: '00' };
  fs.writeFileSync(path.join(home, '.zn', 'audit.jsonl'), JSON.stringify(rec) + '\n');
  for (const cmd of LOG_COMMANDS) {
    const r = zn(home, cmd);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /DB_PASSWORD/);
    assert.match(r.stdout, /chain: not checked/);
    assertNotice(cmd, r);
  }
});

test('the log checks the chain of an unlocked vault and exits 1 when it is broken, in both commands', async (t) => {
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
  const target = lines.findIndex((l) => l.includes('"secret":"DB_PASSWORD"'));
  const tampered = lines.slice();
  tampered[target] = tampered[target].replace('"decision":"allow"', '"decision":"deny"');
  for (const cmd of LOG_COMMANDS) {
    fs.writeFileSync(file, orig);
    let r = zn(home, cmd);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('chain: valid, ' + lines.length + ' records'), r.stdout);
    assertNotice(cmd, r);

    fs.writeFileSync(file, tampered.join('\n') + '\n');
    r = zn(home, cmd);
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('chain: BROKEN: bad mac (record ' + (target + 1) + ')'), r.stdout);
    assertNotice(cmd, r);

    fs.writeFileSync(file, lines.slice(0, -1).join('\n') + '\n');
    r = zn(home, cmd);
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /chain: BROKEN: log truncated/);
    assertNotice(cmd, r);
  }
});

test('a large log is printed completely through a pipe by both commands', async (t) => {
  const home = tempDir(t, 'zn-audit-');
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  const N = 5000;
  const base = Date.now() - 60000;
  const lines = [];
  for (let i = 1; i <= N; i++) {
    lines.push(JSON.stringify({ seq: i, ts: new Date(base + i).toISOString(), decision: 'allow', secret: 'DB_PASSWORD', mode: 'run', agent: 'claude-code', tool: 'Bash', prev: '0', mac: '00' }));
  }
  fs.writeFileSync(path.join(home, '.zn', 'audit.jsonl'), lines.join('\n') + '\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn') };
  for (const cmd of LOG_COMMANDS) {
    // Asynchronous spawn: stdout is a pipe, as when another program runs zn.
    const r = await new Promise((resolve) => {
      const child = require('child_process').spawn(process.execPath, [CLI, ...cmd], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    const out = r.stdout.split('\n').filter(Boolean);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(out.length, N + 1, cmd.join(' ') + ': ' + out.length + ' lines');
    assert.match(out[N], /^chain: /, cmd.join(' '));
  }
});

test('zn vault log --help and zn secret log --help show the usage', (t) => {
  const home = tempDir(t, 'zn-audit-');
  for (const cmd of [['vault', 'log'], ['secret', 'log']]) {
    const r = zn(home, [...cmd, '--help']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /usage: zn vault log/);
  }
});
