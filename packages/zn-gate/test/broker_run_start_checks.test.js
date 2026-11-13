'use strict';

process.env.ZN_STATS = 'off';

// The last checks of `zn run` before a program receives secret values (lib/broker/run.js, spawnChecked): the
// program file is checked again right before it starts, and anything that changed since the first check stops the
// run with nothing started. A start that fails is reported, not thrown. Fictitious values only; each test puts the
// replaced function back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

const exe = require('../lib/exe');
const { runBroker } = require('../lib/broker/run');
const { createFakeVault } = require('./helpers/fake_vault');
const { generateAll } = require('./fixtures/fake_secrets');
const { tempDir } = require('./helpers/tmp');

const FAKE = generateAll(778, { perType: 1, piiPerType: 1 });
const PG = FAKE.secrets.find((s) => s.type === 'postgres_connection_string').sensitive;
const NODE = path.basename(process.execPath).replace(/\.exe$/i, '');
const nodeEnv = { PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') };
const approvals = { isApproved: async () => true, recordApproval: async () => {} };

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

async function vaultWithSecret() {
  const vault = createFakeVault({ withApprovals: true });
  await vault.setSecret('DB_PASSWORD', PG, { mode: 'env', allowCommands: [NODE] });
  return vault;
}

// A program that leaves a file behind when it runs, so a test can tell whether it was started.
function startedProbe(dir) {
  const flag = path.join(dir, 'started.txt');
  return { flag, code: 'require("fs").writeFileSync(' + JSON.stringify(flag) + ', "yes")' };
}

async function runWith(dir, args) {
  const stdout = sink();
  const stderr = sink();
  const code = await runBroker(args, { vault: await vaultWithSecret(), env: nodeEnv, stdout, stderr, stdin: { isTTY: false }, approvals, cwd: dir });
  return { code, out: stdout.text(), err: stderr.text() };
}

function replaced(obj, name, fn) {
  const orig = obj[name];
  obj[name] = fn;
  return () => { obj[name] = orig; };
}

test('zn run: a program file that changed between the check and the start is not started, and no value leaks', async (t) => {
  const dir = tempDir(t, 'zn-run-start-');
  const probe = startedProbe(dir);
  const restore = replaced(exe, 'verifyOpen', () => 'the program file changed after it was checked');
  try {
    const r = await runWith(dir, ['--secrets', 'DB_PASSWORD', '--', NODE, '-e', probe.code]);
    assert.equal(r.code, 77, r.err);
    assert.match(r.err, /changed after it was checked/);
    assert.match(r.err, /it was not started/);
    assert.match(r.err, /something is replacing the program/);
    assert.equal(fs.existsSync(probe.flag), false, 'the program must not run');
    assert.ok(!r.err.includes(PG) && !r.out.includes(PG), 'the secret value is never printed');
  } finally {
    restore();
  }
});

test('zn run: a program that became a script others can rewrite at the second check is not started', async (t) => {
  const dir = tempDir(t, 'zn-run-start-');
  const probe = startedProbe(dir);
  // The first check (when the program is chosen) passes; the second one, right before the start, does not.
  let calls = 0;
  const orig = exe.scriptRisk;
  const restore = replaced(exe, 'scriptRisk', (...a) => (++calls === 1 ? orig(...a) : { deny: 'its folder can be written by other users' }));
  try {
    const r = await runWith(dir, ['--secrets', 'DB_PASSWORD', '--', NODE, '-e', probe.code]);
    assert.equal(r.code, 77, r.err);
    assert.match(r.err, /is a script that others can rewrite \(its folder can be written by other users\)/);
    assert.match(r.err, /it was not started/);
    assert.ok(calls >= 2, 'the script check runs again right before the start');
    assert.equal(fs.existsSync(probe.flag), false, 'the program must not run');
  } finally {
    restore();
  }
});

test('zn run: a program that cannot be started is reported with exit 1 instead of crashing', async (t) => {
  const dir = tempDir(t, 'zn-run-start-');
  // A NUL character in an argument makes the start of the program fail at once.
  const r = await runWith(dir, ['--', NODE, '-e', 'console.log(1)', 'a\u0000b']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /^zn run: /);
});
