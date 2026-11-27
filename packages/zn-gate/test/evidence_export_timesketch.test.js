'use strict';
// evidence --export --format timesketch|timesketch-csv: events Timesketch can import, with the
// chain check carried per event and no agent-written payload text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');
const { logEvidence, writeEvidenceExport } = require('../lib/evidence');
const { timesketchMicros, TIMESKETCH_CSV_HEADERS } = require('../lib/evidence_export');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

function tmpLedger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-timesketch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'evidence.jsonl');
}

function write(file, i, extra = {}) {
  return logEvidence({
    agent: 'test-agent', phase: 'tool-call', tool_name: `tool${i}`, payload: `secret-looking payload number ${i}`,
    verdict: 'allow', latency_us: 7, engine: 'oss-deterministic', ...extra,
  }, file, { noStats: true });
}

async function exportText(file, format) {
  const out = new PassThrough();
  const parts = [];
  out.on('data', (d) => parts.push(d));
  const result = await writeEvidenceExport(file, format, out);
  out.end();
  return { text: Buffer.concat(parts).toString('utf8'), result };
}

function sampleLog(t) {
  const file = tmpLedger(t);
  const recs = [
    write(file, 1),
    write(file, 2, { verdict: 'deny', rule: 'zn_state', reason: 'touches the zn state folder' }),
    write(file, 3, { engine: 'cloud' }),
  ];
  return { file, recs };
}

test('timesketch: one JSON event per record with the three fields Timesketch requires', async (t) => {
  const { file, recs } = sampleLog(t);
  const { text, result } = await exportText(file, 'timesketch');
  assert.equal(result.valid, true);
  assert.equal(result.total, 3);
  assert.ok(text.endsWith('\n'));
  const events = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.length, 3);
  events.forEach((ev, i) => {
    const rec = recs[i];
    assert.equal(ev.datetime, rec.timestamp);
    assert.equal(ev.timestamp_desc, 'zn-gate hook decision');
    assert.equal(ev.data_type, 'zn:gate:decision');
    assert.equal(ev.zn_id, rec.id);
    assert.equal(ev.zn_tool, rec.tool_name);
    assert.equal(ev.zn_verdict, rec.verdict);
    assert.equal(ev.zn_record_hash, rec.record_hash);
    assert.equal(ev.zn_prev_hash, rec.prev_hash);
    assert.equal(ev.zn_payload_sha256, rec.payload_sha256);
    assert.equal(ev.zn_chain_index, i);
    assert.equal(ev.zn_chain_verified, true);
  });
  assert.equal(events[0].message, `allow tool1 by ${recs[0].agent_environment}`);
  assert.equal(events[1].message, `deny tool2 by ${recs[1].agent_environment} (rule zn_state)`);
  assert.equal(events[1].zn_rule, 'zn_state');
  assert.equal(events[1].zn_reason, 'touches the zn state folder');
});

test('timesketch: the payload preview never reaches the export', async (t) => {
  const { file } = sampleLog(t);
  for (const format of ['timesketch', 'timesketch-csv']) {
    const { text } = await exportText(file, format);
    assert.doesNotMatch(text, /payload number/, format);
    assert.doesNotMatch(text, /payload_preview/, format);
  }
});

test('timesketch: records from the first break onwards are marked unverified', async (t) => {
  const { file } = sampleLog(t);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const edited = JSON.parse(lines[1]);
  edited.verdict = 'allow';
  lines[1] = JSON.stringify(edited);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const { text, result } = await exportText(file, 'timesketch');
  assert.equal(result.valid, false);
  assert.equal(result.broken_index, 1);
  const flags = text.trim().split('\n').map((l) => JSON.parse(l).zn_chain_verified);
  assert.deepEqual(flags, [true, false, false]);
});

test('timesketch: a line that is not JSON gives no event and breaks the chain for the rest', async (t) => {
  const { file } = sampleLog(t);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  lines.splice(1, 0, 'not json');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const { text, result } = await exportText(file, 'timesketch');
  assert.equal(result.valid, false);
  const events = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => [e.zn_chain_index, e.zn_chain_verified]), [[0, true], [2, false], [3, false]]);
});

test('timesketch-csv: fixed header, microsecond timestamps and one row per record', async (t) => {
  const { file, recs } = sampleLog(t);
  const { text, result } = await exportText(file, 'timesketch-csv');
  assert.equal(result.valid, true);
  const rows = text.trim().split('\n');
  assert.equal(rows[0], TIMESKETCH_CSV_HEADERS.join(','));
  assert.deepEqual(TIMESKETCH_CSV_HEADERS.slice(0, 4), ['message', 'datetime', 'timestamp', 'timestamp_desc']);
  assert.equal(rows.length, 4);
  const tsCol = TIMESKETCH_CSV_HEADERS.indexOf('timestamp');
  rows.slice(1).forEach((row, i) => {
    const cells = row.match(/"(?:[^"]|"")*"/g).map((c) => c.slice(1, -1).replace(/""/g, '"'));
    assert.equal(cells.length, TIMESKETCH_CSV_HEADERS.length);
    assert.equal(cells[tsCol], String(Date.parse(recs[i].timestamp) * 1000));
    assert.equal(cells[TIMESKETCH_CSV_HEADERS.indexOf('zn_chain_verified')], 'true');
  });
});

test('timesketchMicros: strict UTC ISO 8601 to integer microseconds, anything else empty', () => {
  assert.equal(timesketchMicros('1970-01-01T00:00:00Z'), '0');
  assert.equal(timesketchMicros('2026-11-26T19:30:00.123Z'), String(Date.UTC(2026, 10, 26, 19, 30, 0) * 1000 + 123000));
  assert.equal(timesketchMicros('2026-11-26T19:30:00.123456Z'), String(Date.UTC(2026, 10, 26, 19, 30, 0) * 1000 + 123456));
  assert.equal(timesketchMicros('2026-11-26 19:30:00'), '');
  assert.equal(timesketchMicros('2026-11-26T19:30:00+01:00'), '');
  assert.equal(timesketchMicros(null), '');
  assert.equal(timesketchMicros(42), '');
});

test('timesketchMicros: dates that do not exist are empty, odd but real years keep their value', () => {
  assert.equal(timesketchMicros('2026-02-30T00:00:00Z'), '');
  assert.equal(timesketchMicros('2025-02-29T00:00:00Z'), '');
  assert.equal(timesketchMicros('1900-02-29T00:00:00Z'), '');
  assert.equal(timesketchMicros('2026-13-01T00:00:00Z'), '');
  assert.equal(timesketchMicros('2026-00-10T00:00:00Z'), '');
  assert.equal(timesketchMicros('2026-04-31T00:00:00Z'), '');
  assert.equal(timesketchMicros('2026-01-00T00:00:00Z'), '');
  assert.equal(timesketchMicros('2026-01-01T24:00:00Z'), '');
  assert.equal(timesketchMicros('2026-01-01T00:60:00Z'), '');
  assert.equal(timesketchMicros('2026-12-31T23:59:60Z'), '');
  assert.equal(timesketchMicros('2024-02-29T12:00:00Z'), String(Date.UTC(2024, 1, 29, 12) * 1000));
  assert.equal(timesketchMicros('2000-02-29T00:00:00Z'), String(Date.UTC(2000, 1, 29) * 1000));
  assert.equal(timesketchMicros('1969-12-31T23:59:59.999999Z'), '-1');
  // Date.UTC maps years 0-99 to 1900-1999; the export must not.
  const y50 = new Date(0);
  y50.setUTCFullYear(50, 0, 1);
  assert.equal(timesketchMicros('0050-01-01T00:00:00Z'), String(y50.getTime() * 1000));
  const y0 = new Date(0);
  y0.setUTCFullYear(0, 2, 1);
  assert.equal(timesketchMicros('0000-03-01T00:00:00Z'), String(y0.getTime() * 1000));
  assert.equal(timesketchMicros('9999-12-31T23:59:59Z'), String(Date.UTC(9999, 11, 31, 23, 59, 59) * 1000));
});

test('timesketch: a missing log gives an empty export, and the CSV only its header', async (t) => {
  const file = tmpLedger(t);
  assert.equal((await exportText(file, 'timesketch')).text, '');
  assert.equal((await exportText(file, 'timesketch-csv')).text, TIMESKETCH_CSV_HEADERS.join(',') + '\n');
});

test('CLI: evidence --export accepts timesketch and timesketch-csv', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-timesketch-cli-'));
  try {
    for (const format of ['timesketch', 'timesketch-csv', 'TIMESKETCH']) {
      const r = spawnSync(process.execPath, [CLI, 'evidence', '--export', '--format', format], {
        encoding: 'utf8',
        input: '',
        env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, NO_COLOR: '1', ZN_STATS: 'off', ZN_LOCAL_ONLY: 'true' }),
      });
      assert.equal(r.status, 0, format + ': ' + r.stderr);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
