'use strict';
/* A `#!` script is opened again by its interpreter after zn's last check: a script that can still be rewritten gets no secrets. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const exe = require('../lib/exe');
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

test('rewritableScript: a script of the current user is rewritable, a native program is not a script', { skip: !POSIX }, (t) => {
  const dir = scratch(t);
  const s = path.join(dir, 's.sh');
  fs.writeFileSync(s, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  const a = exe.openExecutable(s);
  const b = exe.openExecutable(fs.realpathSync(process.execPath));
  try {
    assert.ok(exe.rewritableScript(a, s));
    assert.equal(exe.rewritableScript(b, process.execPath), null);
    assert.equal(exe.rewritableScript(null, s), null);
  } finally { fs.closeSync(a.fd); fs.closeSync(b.fd); }
});

test('rewritableScript: a group- or other-writable directory counts', { skip: !POSIX }, (t) => {
  const dir = scratch(t);
  fs.chmodSync(dir, 0o775);
  const s = path.join(dir, 's.sh');
  fs.writeFileSync(s, '#!/bin/sh\n', { mode: 0o555 });
  const a = exe.openExecutable(s);
  try { assert.ok(exe.rewritableScript(a, s)); } finally { fs.closeSync(a.fd); }
});

test('zn run refuses to give a secret to a rewritable script, audits it, and starts nothing', { skip: !POSIX }, async (t) => {
  const dir = scratch(t);
  const marker = path.join(dir, 'ran');
  const s = path.join(dir, 'tool.sh');
  fs.writeFileSync(s, '#!/bin/sh\necho ran > "' + marker + '"\n', { mode: 0o755 });
  const vault = createFakeVault({ withApprovals: true });
  await vault.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: ['tool.sh'] });
  const err = sink();
  const code = await runBroker(['--', 'tool.sh', '__ZN_DB_PASSWORD__'], {
    vault,
    env: { PATH: dir + path.delimiter + '/usr/bin:/bin' },
    stdout: sink(),
    stderr: err,
    stdin: { isTTY: false },
    approvals: { isApproved: async () => true, recordApproval: async () => {} },
    project: '/nonexistent-project',
  });
  assert.equal(code, 77, err.text());
  assert.match(err.text(), /can still be rewritten/);
  assert.ok(!fs.existsSync(marker), 'the script was not started');
  assert.ok(vault.auditLog.some((e) => e.decision === 'deny' && /rewritten/.test(e.reason)));
});

test('zn run still starts a native program with a secret', { skip: !POSIX }, async () => {
  const vault = createFakeVault({ withApprovals: true });
  const NODE = path.basename(process.execPath);
  await vault.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: [NODE] });
  const out = sink();
  const code = await runBroker(['--', NODE, '-e', 'console.log("ok")', '__ZN_DB_PASSWORD__'], {
    vault,
    env: { PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') },
    stdout: out,
    stderr: sink(),
    stdin: { isTTY: false },
    approvals: { isApproved: async () => true, recordApproval: async () => {} },
  });
  assert.equal(code, 0);
  assert.match(out.text(), /ok/);
});
