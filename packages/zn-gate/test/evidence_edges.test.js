'use strict';
/*
 * Edge cases of the evidence dashboard: escapeHtml with empty and non-string
 * input, renderAuditRow with missing or odd fields, and the local server with
 * a missing ledger, an unknown export format and bad Host headers.
 * Ledgers live in temporary directories and every value is fake.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { logEvidence, startEvidenceUi, escapeHtml, renderAuditRow } = require('../lib/evidence');

test('escapeHtml - null, undefined and empty input give an empty string', () => {
  assert.equal(escapeHtml(), '');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(''), '');
});

test('escapeHtml - non-string values are converted, falsy ones are kept', () => {
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(['<a>', 'b']), '&lt;a&gt;,b');
  assert.equal(escapeHtml({}), '[object Object]');
});

test('escapeHtml - text without special characters is unchanged', () => {
  assert.equal(escapeHtml('plain text 123 / = ;'), 'plain text 123 / = ;');
});

test('escapeHtml - ampersand is escaped first, so entities are not decoded twice', () => {
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(escapeHtml('&&'), '&amp;&amp;');
  assert.equal(escapeHtml('<<>>'), '&lt;&lt;&gt;&gt;');
  assert.equal(escapeHtml('"\'"'), '&quot;&#39;&quot;');
});

test('renderAuditRow - an empty record uses the defaults', () => {
  const row = renderAuditRow({});
  assert.ok(row.startsWith('<tr>') && row.endsWith('</tr>'));
  assert.ok(row.includes('tag-allow'));
  assert.ok(row.includes('>ALLOW<'));
  assert.ok(row.includes('<strong>call</strong>'));
  assert.ok(row.includes('(agent)'));
  assert.ok(row.includes('var(--muted);">-</span>'));
  assert.ok(row.includes('title=""'));
  assert.ok(row.includes('>...</td>'));
  assert.ok(row.includes('&lt; 1 ms'));
});

test('renderAuditRow - verdict picks the tag class, unknown verdicts look like allow', () => {
  assert.ok(renderAuditRow({ verdict: 'block' }).includes('tag-block'));
  assert.ok(renderAuditRow({ verdict: 'shadow' }).includes('tag-shadow'));
  assert.ok(renderAuditRow({ verdict: 'weird' }).includes('tag-allow'));
  assert.ok(renderAuditRow({ verdict: 'weird' }).includes('>WEIRD<'));
  // The verdict is compared case-sensitively.
  assert.ok(renderAuditRow({ verdict: 'BLOCK' }).includes('tag-allow'));
});

test('renderAuditRow - rule falls back to reason, and an empty rule shows a dash', () => {
  assert.ok(renderAuditRow({ rule: 'r:one', reason: 'why' }).includes('<td>r:one</td>'));
  assert.ok(renderAuditRow({ reason: 'why' }).includes('<td>why</td>'));
  assert.ok(renderAuditRow({ rule: '', reason: '' }).includes('>-</span>'));
});

test('renderAuditRow - timestamp is shortened to 19 characters with a space', () => {
  const row = renderAuditRow({ timestamp: '2026-01-02T03:04:05.678Z' });
  assert.ok(row.includes('<td class="mono">2026-01-02 03:04:05</td>'));
  assert.ok(renderAuditRow({ timestamp: 'short' }).includes('<td class="mono">short</td>'));
});

test('renderAuditRow - hash is cut to 12 characters, the title keeps the whole value', () => {
  const sha = 'abcdef0123456789abcdef';
  const row = renderAuditRow({ payload_sha256: sha });
  assert.ok(row.includes('title="' + sha + '"'));
  assert.ok(row.includes('>abcdef012345...</td>'));
  assert.ok(!row.includes('abcdef0123456...'));
});

test('renderAuditRow - latency: numbers show microseconds, zero and non-numbers do not', () => {
  assert.ok(renderAuditRow({ latency_us: 250 }).includes('250 µs'));
  assert.ok(renderAuditRow({ latency_us: 0 }).includes('&lt; 1 ms'));
  assert.ok(renderAuditRow({ latency_us: '250' }).includes('&lt; 1 ms'));
  assert.ok(renderAuditRow({ latency_us: null }).includes('&lt; 1 ms'));
});

test('renderAuditRow - a null record throws', () => {
  assert.throws(() => renderAuditRow(null), TypeError);
  assert.throws(() => renderAuditRow(undefined), TypeError);
});

// The request handler is captured from a stubbed http.createServer and called
// with fake request and response objects, so no socket is opened.
function makeApp(ledger, port = 4321) {
  const realCreate = http.createServer;
  let handler;
  const origWrite = process.stdout.write;
  const fake = { listen(p, h, cb) { cb(); return fake; }, address: () => ({ address: '127.0.0.1', port }) };
  http.createServer = (fn) => { handler = fn; return fake; };
  process.stdout.write = (chunk, ...rest) => (String(chunk).includes('Dashboard running')
    ? true : origWrite.call(process.stdout, chunk, ...rest));
  try {
    startEvidenceUi(port, ledger);
  } finally {
    http.createServer = realCreate;
    process.stdout.write = origWrite;
  }
  return (url, host) => {
    const headers = host === undefined ? {} : { host };
    const res = {
      status: null, headers: {}, body: '',
      writeHead(code, h) { this.status = code; this.headers = Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v])); },
      end(b) { this.body = b === undefined ? '' : String(b); },
    };
    handler({ url, headers }, res);
    return res;
  };
}

const HOST = 'localhost:4321';

test('evidence server - a missing ledger gives empty stats, a valid verify and an empty export', (t) => {
  const dir = tempDir(t, 'zn-ev-edge-');
  const app = makeApp(path.join(dir, 'none.jsonl'));
  const stats = JSON.parse(app('/api/stats', HOST).body);
  assert.equal(stats.total, 0);
  assert.deepEqual(stats.recent, []);
  assert.equal(stats.valid, true);

  const verify = app('/api/verify', HOST);
  assert.equal(verify.status, 200);
  assert.equal(JSON.parse(verify.body).valid, true);

  const exp = app('/api/export', HOST);
  assert.equal(exp.status, 200);
  assert.equal(exp.headers['x-evidence-total'], '0');
  assert.equal(exp.body, '');
});

test('evidence server - an unknown export format falls back to jsonl, csv is honoured', (t) => {
  const dir = tempDir(t, 'zn-ev-edge-');
  const ledger = path.join(dir, 'evidence.jsonl');
  logEvidence({ agent: 'test', phase: 'tool-call', tool_name: 'bash', payload: 'fake', verdict: 'allow' }, ledger);
  const app = makeApp(ledger);
  for (const q of ['', '?format=xml', '?format=', '?format=CSV']) {
    const res = app('/api/export' + q, HOST);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].startsWith('application/x-ndjson'), q);
    assert.match(res.headers['content-disposition'], /filename="zn-audit-ledger-\d{4}-\d{2}-\d{2}\.jsonl"/);
    assert.equal(res.headers['x-evidence-integrity'], 'valid');
    assert.equal(res.headers['x-evidence-total'], '1');
  }
  const csv = app('/api/export?format=csv', HOST);
  assert.ok(csv.headers['content-type'].startsWith('text/csv'));
  assert.match(csv.headers['content-disposition'], /\.csv"$/);
});

test('evidence server - an unknown path serves the dashboard page', (t) => {
  const dir = tempDir(t, 'zn-ev-edge-');
  const res = makeApp(path.join(dir, 'none.jsonl'))('/no/such/page', HOST);
  assert.equal(res.status, 200);
  assert.ok(res.headers['content-type'].startsWith('text/html'));
  assert.ok(res.body.includes('<!DOCTYPE html>'));
});

test('evidence server - Host header checks are exact', (t) => {
  const dir = tempDir(t, 'zn-ev-edge-');
  const app = makeApp(path.join(dir, 'none.jsonl'), 4321);
  for (const host of ['127.0.0.1:4321', 'LOCALHOST:4321', 'localhost:4321']) {
    assert.equal(app('/api/stats', host).status, 200, host);
  }
  const bad = [undefined, '', '127.0.0.1', 'localhost', '127.0.0.1:4321.example.test', '[::1]:4321', '192.0.2.1:4321', 'localhost:43210'];
  for (const host of bad) {
    const res = app('/api/stats', host);
    assert.equal(res.status, 403, String(host));
    assert.equal(res.body, 'Forbidden');
  }
});
