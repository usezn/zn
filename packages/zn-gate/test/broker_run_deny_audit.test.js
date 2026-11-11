'use strict';
/*
 * Every way `zn run` can refuse writes an audit record that passes the audit
 * log's field formats, so `zn vault log` shows the tool and a short reason
 * code instead of [invalid]. The long explanation stays on stderr.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');
const { spawnSync } = require('child_process');

const { runBroker } = require('../lib/broker/run');
const audit = require('../lib/vault/audit');
const { createFakeVault } = require('./helpers/fake_vault');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const NODE = path.basename(process.execPath).replace(/\.exe$/i, '');
const nodeEnv = { PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') };
const VALUE = 'fake-db-password-0000';

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

async function vaultWith(meta, opts) {
  const vault = createFakeVault({ withApprovals: true, ...opts });
  await vault.setSecret('DB_PASSWORD', VALUE, { mode: 'env', allowCommands: [NODE], ...meta });
  return vault;
}

/** Run zn run against a fake vault; returns the exit code, stderr and the deny event it audited. */
async function refused(vault, command, extra) {
  const stderr = sink();
  const code = await runBroker(['--secrets', 'DB_PASSWORD', '--', ...command], {
    vault, env: nodeEnv, agent: 'claude-code', stdout: sink(), stderr, stdin: { isTTY: false }, ...extra,
  });
  const denies = vault.auditLog.filter((e) => e.decision === 'deny');
  assert.equal(denies.length, 1, stderr.text());
  return { code, stderr: stderr.text(), event: denies[0] };
}

test('zn run denials: each cause logs the tool zn-run and a short reason code that zn vault log shows', async (t) => {
  const dir = tempDir(t, 'zn-denylog-');
  const script = path.join(dir, 'tool.sh');
  fs.writeFileSync(script, '#!/bin/sh\n', { mode: 0o755 });

  const causes = [];
  const add = (reason, run) => causes.push({ reason, run });

  add('not_in_vault', async () => refused(createFakeVault({ withApprovals: true }), [NODE, '-e', '1']));
  add('policy:org_deny', async () => {
    const vault = await vaultWith({});
    const list = vault.listSecrets.bind(vault);
    vault.listSecrets = async (o) => (await list(o)).map((s) => ({ ...s, deny: true }));
    return refused(vault, [NODE, '-e', '1']);
  });
  add('mode_not_env', async () => refused(await vaultWith({ mode: 'proxy' }), [NODE, '-e', '1']));
  add('command_not_allowed', async () => refused(await vaultWith({ allowCommands: ['some-other-program'] }), [NODE, '-e', '1']));
  add('command_not_found', async () => refused(await vaultWith({ allowCommands: ['zn-no-such-program'] }), ['zn-no-such-program']));
  add('executable_untrusted', async () => refused(await vaultWith({ allowCommands: [script] }), [script]));
  add('not_approved', async () => refused(await vaultWith({}, { confirm: async () => false }), [NODE, '-e', '1'], { stdin: { isTTY: true } }));
  add('no_value', async () => {
    const vault = await vaultWith({});
    vault.resolve = async () => null;
    return refused(vault, [NODE, '-e', '1']);
  });

  const znHome = path.join(dir, '.zn');
  const file = path.join(znHome, 'audit.jsonl');
  const key = crypto.randomBytes(32);
  for (const c of causes) {
    const r = await c.run();
    assert.equal(r.event.tool, 'zn-run', c.reason);
    assert.equal(r.event.reason, c.reason);
    // The long explanation is for stderr only.
    assert.ok(r.stderr.length > r.event.reason.length, c.reason);
    audit.append(r.event, { file, key });
  }

  // Every record keeps its tool and reason: nothing was replaced by [invalid].
  const records = audit.read({ file });
  assert.equal(records.length, causes.length);
  assert.ok(records.every((e) => e.tool === 'zn-run' && e.decision === 'deny' && e.reason !== '[invalid]'));
  assert.deepEqual(audit.verify({ file, key }).ok, true);

  const r = spawnSync(process.execPath, [CLI, 'vault', 'log'], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir, ZN_HOME: znHome }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /\[invalid\]/);
  const lines = r.stdout.split('\n').filter((l) => /\sdeny\s/.test(l));
  assert.equal(lines.length, causes.length);
  causes.forEach((c, i) => {
    const cols = lines[i].split('  ');
    assert.equal(cols[1], 'deny');
    assert.equal(cols[2], 'DB_PASSWORD');
    assert.equal(cols[4], 'claude-code');
    assert.equal(cols[5], 'zn-run');
    assert.equal(cols[7], c.reason);
  });
});

test('zn run: the warn and allow records pass the audit formats too', async () => {
  const vault = await vaultWith({});
  const code = await runBroker(['--secrets', 'DB_PASSWORD', '--', NODE, '-e', '1'], {
    vault, env: nodeEnv, agent: 'claude-code', stdout: sink(), stderr: sink(), stdin: { isTTY: false },
  });
  assert.equal(code, 0);
  const allow = vault.auditLog.find((e) => e.decision === 'allow' && e.secret === 'DB_PASSWORD' && e.tool === 'zn-run');
  assert.ok(allow);
  const clean = audit.sanitize(allow);
  assert.equal(clean.tool, 'zn-run');
  assert.match(clean.reason, /^allow_commands/);
});
