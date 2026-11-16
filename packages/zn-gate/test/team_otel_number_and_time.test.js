'use strict';
/*
 * OTLP/JSON export: time conversion, severity per decision, and which
 * numbers are kept as integer attributes. Checked through the public export.
 */
const test = require('node:test');
const assert = require('node:assert');
const { auditToOtlpJsonLines } = require('../lib/team/otel');

const one = (rec) => JSON.parse(auditToOtlpJsonLines([rec])).resourceLogs[0].scopeLogs[0].logRecords[0];
const attr = (rec, key) => {
  const a = rec.attributes.find((x) => x.key === key);
  return a ? a.value : undefined;
};

test('time before 2038 becomes exact nanoseconds', () => {
  const r = one({ ts: '2030-06-15T12:00:00.000Z', decision: 'allow' });
  assert.strictEqual(r.timeUnixNano, String(Date.parse('2030-06-15T12:00:00.000Z')) + '000000');
  assert.strictEqual(r.observedTimeUnixNano, r.timeUnixNano);
});

test('time after 2038 does not overflow 32 bits', () => {
  const r = one({ ts: '2040-01-01T00:00:00.000Z', decision: 'allow' });
  assert.strictEqual(r.timeUnixNano, '2208988800000000000');
  const r2 = one({ ts: '2038-01-19T03:14:08.000Z', decision: 'allow' });
  assert.strictEqual(r2.timeUnixNano, '2147483648000000000');
});

test('fractional seconds keep milliseconds and drop finer digits', () => {
  assert.strictEqual(one({ ts: '2026-01-02T03:04:05.123Z', decision: 'allow' }).timeUnixNano, '1767323045123000000');
  assert.strictEqual(one({ ts: '2026-01-02T03:04:05.123456Z', decision: 'allow' }).timeUnixNano, '1767323045123000000');
  assert.strictEqual(one({ ts: '2026-01-02T03:04:05Z', decision: 'allow' }).timeUnixNano, '1767323045000000000');
});

test('invalid or non-text time throws', () => {
  for (const ts of ['not a date', '', undefined, null, 1767323045000]) {
    assert.throws(() => one({ ts, decision: 'allow' }), TypeError);
  }
});

test('severity follows the decision name', () => {
  const expected = {
    error: [17, 'ERROR'],
    deny: [13, 'WARN'], warn: [13, 'WARN'], withhold: [13, 'WARN'], 'ask:no': [13, 'WARN'],
    allow: [9, 'INFO'], ask: [9, 'INFO'], 'ask:yes': [9, 'INFO'], restore: [9, 'INFO'],
    other: [9, 'INFO'], '[redacted]': [9, 'INFO'],
  };
  for (const [decision, [num, text]] of Object.entries(expected)) {
    const r = one({ ts: '2026-01-02T03:04:05.000Z', decision });
    assert.strictEqual(r.severityNumber, num, decision);
    assert.strictEqual(r.severityText, text, decision);
  }
});

test('unknown or missing decision is INFO and has no decision attribute', () => {
  for (const decision of ['DENY', 'nope', 5, undefined]) {
    const r = one({ ts: '2026-01-02T03:04:05.000Z', decision });
    assert.strictEqual(r.severityText, 'INFO');
    assert.strictEqual(attr(r, 'zn.decision'), undefined);
  }
});

test('seq keeps zero and positive integers only', () => {
  const ts = '2026-01-02T03:04:05.000Z';
  assert.deepStrictEqual(attr(one({ ts, seq: 0 }), 'zn.audit.seq'), { intValue: '0' });
  assert.deepStrictEqual(attr(one({ ts, seq: 42 }), 'zn.audit.seq'), { intValue: '42' });
  for (const seq of [-1, 1.5, '7', NaN, Infinity, null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.strictEqual(attr(one({ ts, seq }), 'zn.audit.seq'), undefined, String(seq));
  }
});

test('audit version defaults to 1 and drops negative, fractional and text values', () => {
  const ts = '2026-01-02T03:04:05.000Z';
  assert.deepStrictEqual(attr(one({ ts }), 'zn.audit.version'), { intValue: '1' });
  assert.deepStrictEqual(attr(one({ ts, v: null }), 'zn.audit.version'), { intValue: '1' });
  assert.deepStrictEqual(attr(one({ ts, v: 0 }), 'zn.audit.version'), { intValue: '0' });
  assert.deepStrictEqual(attr(one({ ts, v: 2 }), 'zn.audit.version'), { intValue: '2' });
  for (const v of [-1, 0.5, '2', NaN]) {
    assert.strictEqual(attr(one({ ts, v }), 'zn.audit.version'), undefined, String(v));
  }
});
