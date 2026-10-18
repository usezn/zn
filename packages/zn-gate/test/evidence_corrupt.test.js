'use strict';

// A ledger with invalid bytes or a broken line is reported as corrupted and never lets
// the next write silently restart the hash chain.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  getLastHash, logEvidence, verifyEvidenceLedger, getEvidenceStats, exportEvidenceLedger, EvidenceLedgerError, GENESIS_HASH,
} = require('../lib/evidence');

function tmpLedger(n = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-corrupt-'));
  const file = path.join(dir, 'evidence.jsonl');
  for (let i = 0; i < n; i++) logEvidence({ payload: `example-${i}`, tool_name: 'bash' }, file);
  return { dir, file };
}

const makers = {
  'invalid bytes at the end': (file) => { fs.appendFileSync(file, Buffer.from([0xff, 0xfe, 0x80, 0x67, 0x0a])); return 3; },
  'invalid bytes in the middle': (file) => {
    const lines = fs.readFileSync(file).toString('latin1').split('\n');
    lines[1] = lines[1].slice(0, 20) + '\xff\xfe' + lines[1].slice(20);
    fs.writeFileSync(file, Buffer.from(lines.join('\n'), 'latin1'));
    return 2;
  },
  'truncated last line': (file) => {
    const data = fs.readFileSync(file);
    fs.writeFileSync(file, data.subarray(0, data.length - 40));
    return 2;
  },
};

const TAIL_ONLY = new Set(['invalid bytes at the end', 'truncated last line']);

function freshEvidence() {
  delete require.cache[require.resolve('../lib/evidence')];
  return require('../lib/evidence');
}

function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => { out += chunk; return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return out;
}

test('valid, empty and missing ledgers are unchanged', () => {
  const { dir, file } = tmpLedger(3);
  try {
    assert.equal(verifyEvidenceLedger(file).valid, true);
    assert.equal(getEvidenceStats(file).valid, true);
    assert.equal(exportEvidenceLedger(file).valid, true);
    const empty = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    assert.equal(verifyEvidenceLedger(empty).valid, true);
    assert.equal(logEvidence({ payload: 'x' }, empty).prev_hash, GENESIS_HASH);
    assert.equal(logEvidence({ payload: 'x' }, path.join(dir, 'missing.jsonl')).prev_hash, GENESIS_HASH);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, make] of Object.entries(makers)) {
  test(`corrupt ledger (${name}): verify, stats and export report it`, () => {
    const { dir, file } = tmpLedger();
    try {
      const line = make(file);
      const v = verifyEvidenceLedger(file);
      assert.equal(v.valid, false);
      assert.match(v.error, new RegExp(`line ${line}`));
      assert.equal(v.broken_index, line - 1);
      const s = getEvidenceStats(file);
      assert.equal(s.valid, false);
      assert.ok(s.error);
      for (const fmt of ['jsonl', 'csv']) {
        const e = exportEvidenceLedger(file, fmt);
        assert.equal(e.valid, false);
        assert.ok(e.error);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// logEvidence reads only the end of the file: it refuses on damage to the last line.
// Damage earlier in the file is found by verify (see the middle-of-file test below).
for (const name of TAIL_ONLY) {
  const make = makers[name];
  test(`corrupt ledger (${name}): logEvidence refuses to append and warns once`, () => {
    const { dir, file } = tmpLedger();
    try {
      make(file);
      const before = fs.readFileSync(file);
      const fresh = freshEvidence();
      let r1; let r2;
      const err = captureStderr(() => {
        r1 = fresh.logEvidence({ payload: 'after' }, file);
        r2 = fresh.logEvidence({ payload: 'again' }, file);
      });
      assert.equal(r1, null);
      assert.equal(r2, null);
      assert.ok(fs.readFileSync(file).equals(before), 'nothing is appended');
      assert.equal(err.split("is damaged").length - 1, 1, 'warns once');
      assert.match(err, /--verify/);
      assert.match(err, /evidence\.damaged\.jsonl/, 'tells the user how to recover');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('invalid bytes are named in the verify message', () => {
  const { dir, file } = tmpLedger();
  try {
    makers['invalid bytes at the end'](file);
    assert.match(verifyEvidenceLedger(file).error, /Invalid UTF-8/);
    assert.ok(EvidenceLedgerError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('damage in the middle is found by verify and not hidden by appending', () => {
  const { dir, file } = tmpLedger(3);
  try {
    makers['invalid bytes in the middle'](file);
    assert.ok(logEvidence({ payload: 'after' }, file));
    const v = verifyEvidenceLedger(file);
    assert.equal(v.valid, false);
    assert.match(v.error, /line 2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a huge damaged last line still fails closed; a long valid log gives the last hash', () => {
  const { dir, file } = tmpLedger();
  try {
    fs.appendFileSync(file, Buffer.alloc(300000, 0x78));
    assert.throws(() => getLastHash(file), EvidenceLedgerError);
    const long = path.join(dir, 'long.jsonl');
    let last;
    for (let i = 0; i < 300; i++) last = logEvidence({ payload: `example-${i}` }, long);
    assert.equal(getLastHash(long), last.record_hash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the warning repeats after five minutes, not before', () => {
  const { dir, file } = tmpLedger();
  const realNow = Date.now;
  try {
    makers['invalid bytes at the end'](file);
    const fresh = freshEvidence();
    let t = 1000000;
    Date.now = () => t;
    const count = () => captureStderr(() => fresh.logEvidence({ payload: 'x' }, file)).split("is damaged").length - 1;
    assert.equal(count(), 1);
    t += 5 * 60 * 1000 - 1;
    assert.equal(count(), 0);
    t += 2;
    assert.equal(count(), 1);
  } finally {
    Date.now = realNow;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, junk] of [['BOM', Buffer.from([0xef, 0xbb, 0xbf])], ['NBSP', Buffer.from([0xc2, 0xa0])]]) {
  for (const where of ['start', 'end']) {
    test(`${label} at the ${where} of a line is not trimmed (same result as Python)`, () => {
      const { dir, file } = tmpLedger();
      try {
        const lines = fs.readFileSync(file).toString('latin1').split('\n');
        const j = junk.toString('latin1');
        lines[0] = where === 'start' ? j + lines[0] : lines[0] + j;
        fs.writeFileSync(file, Buffer.from(lines.join('\n'), 'latin1'));
        const v = verifyEvidenceLedger(file);
        assert.equal(v.valid, false);
        assert.match(v.error, /line 1/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test('CRLF and tab/space padding stay valid', () => {
  const { dir, file } = tmpLedger();
  try {
    fs.writeFileSync(file, fs.readFileSync(file, 'latin1').replace(/\n/g, ' \t\r\n'), 'latin1');
    assert.equal(verifyEvidenceLedger(file).valid, true);
    assert.equal(getLastHash(file).length, 64);
    assert.ok(logEvidence({ payload: 'next' }, file));
    assert.equal(verifyEvidenceLedger(file).valid, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- record_hash must be 64 lowercase hex characters ----

for (const [label, bad] of [['not hex', 'z'.repeat(64)], ['upper case', 'A'.repeat(64)], ['with a space', 'a'.repeat(63) + ' ']]) {
  test(`a last record_hash that is ${label} fails closed`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-hex-'));
    const file = path.join(dir, 'evidence.jsonl');
    try {
      fs.writeFileSync(file, JSON.stringify({ id: 'x', prev_hash: GENESIS_HASH, record_hash: bad }) + '\n');
      assert.throws(() => getLastHash(file), EvidenceLedgerError);
      const before = fs.readFileSync(file);
      const fresh = freshEvidence();
      let r;
      const err = captureStderr(() => { r = fresh.logEvidence({ payload: 'after' }, file); });
      assert.equal(r, null);
      assert.match(err, /is damaged/);
      assert.ok(fs.readFileSync(file).equals(before), 'nothing is appended');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ---- a log that cannot be written never breaks the caller ----

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('a log that is readable but not writable: warns, writes nothing, does not throw', { skip: process.platform === 'win32' || isRoot }, () => {
  const { dir, file } = tmpLedger();
  try {
    fs.chmodSync(file, 0o400);
    const before = fs.readFileSync(file);
    const fresh = freshEvidence();
    let r1; let r2;
    const err = captureStderr(() => {
      r1 = fresh.logEvidence({ payload: 'after' }, file);
      r2 = fresh.logEvidence({ payload: 'again' }, file);
    });
    assert.equal(r1, null);
    assert.equal(r2, null);
    assert.equal(err.split('cannot write to the evidence log').length - 1, 1, 'warns once');
    assert.ok(fs.readFileSync(file).equals(before));
    assert.equal(verifyEvidenceLedger(file).valid, true);
    assert.equal(fs.existsSync(file + '.lock'), false, 'the lock is released');
  } finally {
    fs.chmodSync(file, 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory that cannot be written: warns, does not throw', { skip: process.platform === 'win32' || isRoot }, () => {
  const { dir } = tmpLedger(0);
  const sub = path.join(dir, 'ro');
  try {
    fs.mkdirSync(sub, { mode: 0o500 });
    const fresh = freshEvidence();
    let r;
    const err = captureStderr(() => { r = fresh.logEvidence({ payload: 'x' }, path.join(sub, 'evidence.jsonl')); });
    assert.equal(r, null);
    assert.match(err, /cannot write to the evidence log/);
  } finally {
    fs.chmodSync(sub, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the write lock ----

test('a busy lock makes the write skip after a short wait, not hang', () => {
  const { dir, file } = tmpLedger(1);
  try {
    assert.equal(fs.existsSync(file + '.lock'), false, 'released after a normal write');
    fs.writeFileSync(file + '.lock', '99999');
    const before = fs.readFileSync(file);
    const fresh = freshEvidence();
    let r;
    const t0 = Date.now();
    const err = captureStderr(() => { r = fresh.logEvidence({ payload: 'blocked' }, file); });
    const waited = Date.now() - t0;
    assert.equal(r, null);
    assert.ok(waited >= 1500 && waited < 8000, `waited ${waited} ms`);
    assert.match(err, /another process is writing/);
    assert.ok(fs.readFileSync(file).equals(before), 'nothing is written without the lock');
    assert.equal(fs.existsSync(file + '.lock'), true, 'a lock held by someone else is left alone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale lock (older than 10 seconds) is removed and the write goes through', () => {
  const { dir, file } = tmpLedger(1);
  try {
    fs.writeFileSync(file + '.lock', '99999');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(file + '.lock', old, old);
    assert.ok(logEvidence({ payload: 'after the crash' }, file));
    assert.equal(fs.existsSync(file + '.lock'), false);
    const v = verifyEvidenceLedger(file);
    assert.equal(v.total, 2);
    assert.equal(v.valid, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const { spawn, spawnSync } = require('child_process');
const EVIDENCE_JS = path.join(__dirname, '..', 'lib', 'evidence.js');
const PY_SRC = path.join(__dirname, '..', '..', 'zn-gate-py', 'src');

function findPython() {
  for (const cmd of ['python3', 'python']) {
    const r = spawnSync(cmd, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { encoding: 'utf8' });
    if (r.status === 0) return cmd;
  }
  return null;
}
const PYTHON = findPython();
const NO_PY = PYTHON ? false : 'no python on this machine';

const NODE_WRITER = `
const { logEvidence } = require(process.argv[1]);
const [, , file, id, n] = process.argv;
for (let i = 0; i < Number(n); i++) {
  if (!logEvidence({ payload: 'node-' + id + '-' + i, tool_name: 'bash' }, file)) process.exit(3);
}
`;
const PY_WRITER = `
import sys
sys.path.insert(0, sys.argv[1])
from zn_gate.evidence import log_evidence
file, wid, n = sys.argv[2], sys.argv[3], int(sys.argv[4])
for i in range(n):
    if log_evidence({"payload": "py-%s-%d" % (wid, i), "tool_name": "bash"}, file_path=file) is None:
        sys.exit(3)
`;

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, err }));
  });
}

test('concurrent Node writers keep one chain (no forks, no lost records)', async () => {
  const { dir, file } = tmpLedger(0);
  try {
    const N = 6;
    const PER = 40;
    const results = await Promise.all(Array.from({ length: N }, (_, i) => run(process.execPath, ['-e', NODE_WRITER, EVIDENCE_JS, file, String(i), String(PER)])));
    for (const r of results) assert.equal(r.code, 0, r.err);
    const v = verifyEvidenceLedger(file);
    assert.equal(v.error, null);
    assert.equal(v.valid, true);
    assert.equal(v.total, N * PER);
    assert.equal(fs.existsSync(file + '.lock'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Node and Python writers at the same time share one chain', { skip: NO_PY }, async () => {
  const { dir, file } = tmpLedger(0);
  try {
    const PER = 40;
    const jobs = [];
    for (let i = 0; i < 3; i++) {
      jobs.push(run(process.execPath, ['-e', NODE_WRITER, EVIDENCE_JS, file, String(i), String(PER)]));
      jobs.push(run(PYTHON, ['-c', PY_WRITER, PY_SRC, file, String(i), String(PER)]));
    }
    for (const r of await Promise.all(jobs)) assert.equal(r.code, 0, r.err);
    const v = verifyEvidenceLedger(file);
    assert.equal(v.error, null);
    assert.equal(v.valid, true);
    assert.equal(v.total, 6 * PER);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- one canonical form for non-ASCII text, shared with Python ----

const NON_ASCII = 'café ñandú 漢字 😀 end';

test('non-ASCII records: written by Node, verified by Node and by Python', { skip: NO_PY }, () => {
  const { dir, file } = tmpLedger(0);
  try {
    for (let i = 0; i < 3; i++) logEvidence({ payload: NON_ASCII, tool_name: 'bash', reason: NON_ASCII }, file);
    assert.equal(verifyEvidenceLedger(file).valid, true);
    const code = 'import sys, json\nsys.path.insert(0, sys.argv[1])\nfrom zn_gate.evidence import verify_evidence_ledger\nprint(json.dumps(verify_evidence_ledger(sys.argv[2])))';
    const r = spawnSync(PYTHON, ['-c', code, PY_SRC, file], { encoding: 'utf8' });
    const v = JSON.parse(r.stdout);
    assert.equal(v.valid, true, r.stdout + r.stderr);
    assert.equal(v.total, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('non-ASCII records: written by Python, verified by Node', { skip: NO_PY }, () => {
  const { dir, file } = tmpLedger(0);
  try {
    const code = 'import sys\nsys.path.insert(0, sys.argv[1])\nfrom zn_gate.evidence import log_evidence\n'
      + 'for _ in range(3):\n    assert log_evidence({"payload": sys.argv[3], "reason": sys.argv[3], "tool_name": "bash"}, file_path=sys.argv[2])\n';
    const r = spawnSync(PYTHON, ['-c', code, PY_SRC, file, NON_ASCII], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const v = verifyEvidenceLedger(file);
    assert.equal(v.error, null);
    assert.equal(v.valid, true);
    assert.equal(v.total, 3);
    assert.ok(fs.readFileSync(file, 'utf8').includes('漢字'), 'the new form writes text as is');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a log written by an older Python version (non-ASCII escaped) still verifies and can be extended', () => {
  const { dir } = tmpLedger(0);
  try {
    const file = path.join(dir, 'old.jsonl');
    const crypto = require('crypto');
    // The old form: the hash is taken over the \uXXXX-escaped serialization.
    let prev = GENESIS_HASH;
    for (let i = 0; i < 2; i++) {
      const base = { id: `ev_old_${i}`, timestamp: '2026-01-01T00:00:00+00:00', agent_environment: 'python-agent', phase: 'tool-call', tool_name: 'bash', payload_sha256: 'a'.repeat(64), payload_preview: NON_ASCII, verdict: 'allow', rule: null, reason: null, confidence: 1, latency_us: 0, engine: 'python-deterministic', prev_hash: prev };
      const escaped = JSON.stringify(base).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      assert.ok(escaped.includes('\\u6f22'), 'escaped form');
      const hash = crypto.createHash('sha256').update(prev + ':' + escaped).digest('hex');
      fs.appendFileSync(file, escaped.slice(0, -1) + `,"record_hash":"${hash}"}\n`);
      prev = hash;
    }
    assert.equal(verifyEvidenceLedger(file).valid, true);
    assert.ok(logEvidence({ payload: NON_ASCII }, file));
    const v = verifyEvidenceLedger(file);
    assert.equal(v.valid, true);
    assert.equal(v.total, 3);
    // A real change is still caught.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('ev_old_0', 'ev_old_X'));
    assert.equal(verifyEvidenceLedger(file).valid, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- lock ownership and edge cases ----

test('a writer that lost its lock to a takeover writes nothing and leaves the new lock alone', () => {
  const { dir, file } = tmpLedger(1);
  try {
    const before = fs.readFileSync(file);
    const fresh = freshEvidence();
    let r;
    const err = captureStderr(() => {
      r = fresh.logEvidence({ payload: 'slow writer' }, file, {
        // Simulates a stalled writer: someone else broke its lock and took it.
        beforeAppend: () => fs.writeFileSync(file + '.lock', '4242:otherwriter'),
      });
    });
    assert.equal(r, null);
    assert.match(err, /taken over/);
    assert.ok(fs.readFileSync(file).equals(before), 'nothing is appended');
    assert.equal(fs.readFileSync(file + '.lock', 'utf8'), '4242:otherwriter', 'the other lock is not deleted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('several writers meeting one stale lock: all writes land, one chain', async () => {
  const { dir, file } = tmpLedger(0);
  try {
    fs.writeFileSync(file + '.lock', '1:crashed');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(file + '.lock', old, old);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => run(process.execPath, ['-e', NODE_WRITER, EVIDENCE_JS, file, String(i), '5'])));
    for (const r of results) assert.equal(r.code, 0, r.err);
    const v = verifyEvidenceLedger(file);
    assert.equal(v.error, null);
    assert.equal(v.valid, true);
    assert.equal(v.total, 30);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.lock')), [], 'no lock or stale file left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock dated in the future counts as stale', () => {
  const { dir, file } = tmpLedger(1);
  try {
    fs.writeFileSync(file + '.lock', '1:crashed');
    const future = new Date(Date.now() + 3600 * 1000);
    fs.utimesSync(file + '.lock', future, future);
    assert.ok(logEvidence({ payload: 'after clock change' }, file));
    assert.equal(verifyEvidenceLedger(file).total, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock path that cannot be read does not spin the CPU while waiting', { skip: process.platform === 'win32' }, () => {
  const { dir, file } = tmpLedger(1);
  try {
    fs.symlinkSync(path.join(dir, 'missing-target'), file + '.lock');
    const cpu0 = process.cpuUsage();
    const fresh = freshEvidence();
    let r;
    captureStderr(() => { r = fresh.logEvidence({ payload: 'x' }, file, { lockWaitMs: 600 }); });
    const used = process.cpuUsage(cpu0);
    assert.equal(r, null);
    assert.ok((used.user + used.system) / 1000 < 400, `used ${(used.user + used.system) / 1000} ms of CPU in a 600 ms wait`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
