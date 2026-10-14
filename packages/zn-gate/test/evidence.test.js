'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { logEvidence, verifyEvidenceLedger, getEvidenceStats, exportEvidenceLedger, startEvidenceUi, escapeHtml, renderAuditRow } = require('../lib/evidence');

test('evidence engine - appends cryptographically chained records', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-test-'));
  const testLedger = path.join(tmpDir, 'evidence.jsonl');

  try {
    const rec1 = logEvidence({
      agent: 'claude-code',
      phase: 'tool-call',
      tool_name: 'bash',
      payload: 'cat ~/.ssh/id_rsa',
      verdict: 'block',
      rule: 'LFI_SSH_PATTERN',
      latency_us: 25,
      engine: 'oss-hybrid'
    }, testLedger);

    assert.equal(rec1.prev_hash, '0'.repeat(64));
    assert.ok(rec1.record_hash && rec1.record_hash.length === 64);
    assert.equal(rec1.verdict, 'block');

    const rec2 = logEvidence({
      agent: 'cursor',
      phase: 'tool-result',
      tool_name: 'postgres',
      payload: 'SELECT 1',
      verdict: 'allow',
      rule: null,
      latency_us: 10,
      engine: 'oss-deterministic'
    }, testLedger);

    assert.equal(rec2.prev_hash, rec1.record_hash);
    assert.ok(rec2.record_hash && rec2.record_hash.length === 64);

    const stats = getEvidenceStats(testLedger);
    assert.equal(stats.total, 2);
    assert.equal(stats.blocks, 1);
    assert.equal(stats.allows, 1);

    const check = verifyEvidenceLedger(testLedger);
    assert.equal(check.valid, true);
    assert.equal(check.total, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('evidence engine - detects any data tampering in ledger lines', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-tamper-'));
  const testLedger = path.join(tmpDir, 'evidence.jsonl');

  try {
    logEvidence({ agent: 'a', tool_name: 't1', verdict: 'block', rule: 'R1' }, testLedger);
    logEvidence({ agent: 'b', tool_name: 't2', verdict: 'allow', rule: null }, testLedger);
    logEvidence({ agent: 'c', tool_name: 't3', verdict: 'block', rule: 'R2' }, testLedger);

    // Initial verify
    const initialCheck = verifyEvidenceLedger(testLedger);
    assert.equal(initialCheck.valid, true);
    assert.equal(initialCheck.total, 3);

    // Tamper with record 0 (first record verdict changed from block to allow)
    const raw = fs.readFileSync(testLedger, 'utf8').trim().split('\n');
    const parsed1 = JSON.parse(raw[0]);
    parsed1.verdict = 'allow'; // Malicious modification
    raw[0] = JSON.stringify(parsed1);
    fs.writeFileSync(testLedger, raw.join('\n') + '\n', 'utf8');

    // Re-verify: must detect tamper!
    const tamperedCheck = verifyEvidenceLedger(testLedger);
    assert.equal(tamperedCheck.valid, false);
    assert.equal(tamperedCheck.broken_index, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('evidence engine - exports ledger to JSONL and CSV with cryptographic verification', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-export-'));
  const testLedger = path.join(tmpDir, 'evidence.jsonl');

  try {
    logEvidence({ agent: 'claude-code', phase: 'tool-call', tool_name: 'bash', payload: 'whoami', verdict: 'allow', latency_us: 15 }, testLedger);
    logEvidence({ agent: 'cursor', phase: 'tool-call', tool_name: 'bash', payload: 'cat /etc/passwd', verdict: 'block', rule: 'path:sensitive_file', latency_us: 20 }, testLedger);

    const jsonlExport = exportEvidenceLedger(testLedger, 'jsonl');
    assert.equal(jsonlExport.format, 'jsonl');
    assert.equal(jsonlExport.valid, true);
    assert.equal(jsonlExport.total, 2);
    assert.ok(jsonlExport.content.includes('whoami'));
    assert.ok(jsonlExport.content.includes('path:sensitive_file'));

    const csvExport = exportEvidenceLedger(testLedger, 'csv');
    assert.equal(csvExport.format, 'csv');
    assert.equal(csvExport.valid, true);
    assert.equal(csvExport.total, 2);
    assert.ok(csvExport.content.startsWith('timestamp,verdict,phase,tool_name'));
    assert.ok(csvExport.content.includes('"allow"'));
    assert.ok(csvExport.content.includes('"block"'));
    assert.ok(csvExport.content.includes('"path:sensitive_file"'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function status(port, urlPath, host) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

test('evidence dashboard - escapes every ledger field rendered as HTML', () => {
  assert.equal(escapeHtml('<b>"x"</b> & \'y\''), '&lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; &#39;y&#39;');
  const row = renderAuditRow({
    timestamp: '<i>2026-01-01T00:00:00Z</i>',
    verdict: '<script>',
    tool_name: '<b>x</b>',
    agent_environment: '<img src=x onerror=alert(1)>',
    rule: '<u>rule</u>',
    payload_sha256: '"><svg onload=alert(1)>',
    latency_us: '<em>5</em>',
  });
  assert.ok(row.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(!row.includes('<b>x</b>'));
  assert.ok(!row.includes('<img'));
  assert.ok(!row.includes('<svg'));
  assert.ok(!row.includes('<u>'));
  assert.ok(!row.includes('<script>'));
  assert.ok(!row.includes('<em>'));
  assert.ok(!row.includes('<i>'));
});

test('evidence dashboard - listens on loopback only and serves the escaping renderer', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-ui-'));
  const testLedger = path.join(tmpDir, 'evidence.jsonl');
  const origWrite = process.stdout.write;
  let banner = '';
  let server;
  try {
    logEvidence({ agent: 'test', phase: 'tool-call', tool_name: '<b>x</b>', payload: 'fake', verdict: 'block', rule: 'pi:test' }, testLedger);
    process.stdout.write = (chunk, ...rest) => {
      if (String(chunk).includes('Dashboard running')) { banner += String(chunk); return true; }
      return origWrite.call(process.stdout, chunk, ...rest);
    };
    server = startEvidenceUi(0, testLedger);
    await new Promise((resolve) => server.once('listening', resolve));
    await new Promise((resolve) => setImmediate(resolve));
    process.stdout.write = origWrite;

    const addr = server.address();
    assert.equal(addr.address, '127.0.0.1');
    assert.ok(banner.includes(`http://127.0.0.1:${addr.port}`));
    assert.ok(!banner.includes('localhost'));

    const page = await get(addr.port, '/');
    assert.ok(page.includes('function escapeHtml('));
    assert.ok(page.includes('function renderAuditRow('));
    assert.ok(page.includes('d.recent.map(renderAuditRow)'));
    assert.ok(!page.includes("'<strong>' + (r.tool_name"));

    const stats = JSON.parse(await get(addr.port, '/api/stats'));
    const row = renderAuditRow(stats.recent[0]);
    assert.ok(row.includes('&lt;b&gt;x&lt;/b&gt;'));

    // Requests for another host name (DNS rebinding) are refused.
    assert.equal(await status(addr.port, '/api/stats', `localhost:${addr.port}`), 200);
    assert.equal(await status(addr.port, '/api/stats', 'attacker.example'), 403);
    assert.equal(await status(addr.port, '/api/export', `attacker.example:${addr.port}`), 403);
    assert.equal(await status(addr.port, '/', `127.0.0.1:${addr.port + 1}`), 403);
  } finally {
    process.stdout.write = origWrite;
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('evidence ledger - directory is 0700 and file is 0600 on POSIX', { skip: process.platform === 'win32' }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-mode-'));
  const ledgerDir = path.join(tmpDir, 'zn');
  const ledger = path.join(ledgerDir, 'evidence.jsonl');
  try {
    logEvidence({ agent: 'mode-test', payload: 'ok', verdict: 'allow' }, ledger);
    assert.equal(fs.statSync(ledgerDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(ledger).mode & 0o777, 0o600);

    // A ledger that others can read is restricted again on the next write.
    fs.chmodSync(ledger, 0o644);
    logEvidence({ agent: 'mode-test', payload: 'ok', verdict: 'allow' }, ledger);
    assert.equal(fs.statSync(ledger).mode & 0o777, 0o600);
    assert.equal(verifyEvidenceLedger(ledger).valid, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
