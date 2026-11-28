'use strict';
// zn team leave shows the revocations still pending on the server; zn vault log export with an unlocked vault refuses a log that
// cannot be read, and says so, loudly, when the chain does not verify.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-cov56-team-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const clientModule = require('../lib/vault/client');
let fake = {};
clientModule.createClient = () => new Proxy({}, {
  get(target, prop) {
    if (prop === 'close') return () => {};
    if (typeof fake[prop] === 'function') return fake[prop];
    return () => { throw Object.assign(new Error('unexpected call ' + String(prop)), { code: 'ZN_TEST' }); };
  },
});

const store = require('../lib/vault/store');
const { runTeamCommand, runLogExport } = require('../lib/team/cli');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
test.beforeEach(() => {
  fake = {};
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
});

async function capture(fn) {
  const o = process.stdout.write;
  const e = process.stderr.write;
  let stdout = '';
  let stderr = '';
  process.stdout.write = (s) => { stdout += s; return true; };
  process.stderr.write = (s) => { stderr += s; return true; };
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

function writeAudit() {
  const file = store.paths().auditFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"seq":1}\n');
}

test('leave lists each revocation still pending on the server, with its next step', async () => {
  fake.teamLeave = async () => ({
    left: null,
    pending_files: [],
    revocations: [{ since: '2026-11-20', install_id: 'inst-0009', org: 'org_Example12345678', last_error: 'timeout', give_up_at: '2026-12-01' }],
  });
  const r = await capture(() => runTeamCommand(['team', 'leave']));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Not in an organization\./);
  assert.match(r.stdout, /Revocation pending since 2026-11-20 \(installation inst-0009, org_Example12345678\): last error timeout/);
  assert.match(r.stdout, /zn team sync/);
});

test('log export with an unlocked vault refuses a log that cannot be read, and says it is not a changed log', async () => {
  writeAudit();
  fake.isUnlocked = async () => true;
  fake.auditExport = async () => ({ ok: false, tampered: false, error: 'the log file could not be read' });
  const out = path.join(HOME, 'read-error-out.jsonl');
  const r = await capture(() => runLogExport(['--otlp', '--out', out]));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\[zn\] Not exported: the log file could not be read/);
  assert.ok(!fs.existsSync(out));
});

test('log export with an unlocked vault whose chain does not verify refuses, and asks for a copy as evidence', async () => {
  writeAudit();
  fake.isUnlocked = async () => true;
  fake.auditExport = async () => ({ ok: false, tampered: true, error: 'chain broken at record 1' });
  const out = path.join(HOME, 'tampered-out.jsonl');
  const r = await capture(() => runLogExport(['--otlp', '--out', out]));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Not exported: chain broken at record 1\. Keep a copy of .*audit\.jsonl as evidence/);
  assert.match(r.stderr, /vault verify --acknowledge/);
  assert.ok(!fs.existsSync(out));
});
