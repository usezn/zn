'use strict';
/*
 * OTLP/JSON export of audit records: event shape, empty input, long names.
 */
const test = require('node:test');
const assert = require('node:assert');
const { auditToOtlpJsonLines } = require('../lib/team/otel');

const TS = '2026-01-02T03:04:05.000Z';
const attr = (rec, key) => {
  const a = rec.attributes.find((x) => x.key === key);
  return a ? a.value : undefined;
};
const parse = (out) => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('one record becomes one zn.gate.decision log event', () => {
  const out = auditToOtlpJsonLines([
    { ts: TS, seq: 1, decision: 'deny', agent: 'example-agent', tool: 'Bash', secret: 'EXAMPLE_KEY', host: 'example.com:8443' },
  ]);
  assert.ok(out.endsWith('\n'));
  const [req] = parse(out);
  const res = req.resourceLogs[0];
  assert.deepStrictEqual(res.resource.attributes, [{ key: 'service.name', value: { stringValue: 'zn-gate' } }]);
  assert.strictEqual(res.scopeLogs[0].scope.name, 'usezn.evidence');
  const recs = res.scopeLogs[0].logRecords;
  assert.strictEqual(recs.length, 1);
  const r = recs[0];
  assert.strictEqual(r.eventName, 'zn.gate.decision');
  assert.strictEqual(r.timeUnixNano, String(Date.parse(TS)) + '000000');
  assert.strictEqual(r.observedTimeUnixNano, r.timeUnixNano);
  assert.strictEqual(r.severityNumber, 13);
  assert.strictEqual(r.severityText, 'WARN');
  assert.strictEqual(r.body.stringValue, 'deny agent=example-agent tool=Bash secret=EXAMPLE_KEY');
  assert.deepStrictEqual(attr(r, 'event.name'), { stringValue: 'zn.gate.decision' });
  assert.deepStrictEqual(attr(r, 'server.address'), { stringValue: 'example.com' });
  assert.deepStrictEqual(attr(r, 'server.port'), { intValue: '8443' });
  assert.deepStrictEqual(attr(r, 'zn.audit.seq'), { intValue: '1' });
});

test('empty or non-array input gives an empty string', () => {
  assert.strictEqual(auditToOtlpJsonLines([]), '');
  assert.strictEqual(auditToOtlpJsonLines(undefined), '');
  assert.strictEqual(auditToOtlpJsonLines(null), '');
  assert.strictEqual(auditToOtlpJsonLines([null, 'x', 3]), '');
});

test('a name longer than 64 characters is dropped, not passed through', () => {
  const long = 'a'.repeat(65);
  const [req] = parse(auditToOtlpJsonLines([
    { ts: TS, seq: 1, decision: 'allow', agent: long, tool: 'b'.repeat(64) },
  ]));
  const r = req.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.strictEqual(attr(r, 'gen_ai.agent.name'), undefined);
  assert.deepStrictEqual(attr(r, 'gen_ai.tool.name'), { stringValue: 'b'.repeat(64) });
  assert.strictEqual(r.body.stringValue, 'allow tool=' + 'b'.repeat(64));
  assert.ok(!JSON.stringify(req).includes(long));
});

test('a record without a valid timestamp throws', () => {
  assert.throws(() => auditToOtlpJsonLines([{ seq: 1, decision: 'allow' }]), TypeError);
});

test('records are ordered by seq and split into lines of 500', () => {
  const recs = [];
  for (let i = 501; i >= 1; i--) recs.push({ ts: TS, seq: i, decision: 'allow' });
  const lines = parse(auditToOtlpJsonLines(recs));
  assert.strictEqual(lines.length, 2);
  const first = lines[0].resourceLogs[0].scopeLogs[0].logRecords;
  assert.strictEqual(first.length, 500);
  assert.deepStrictEqual(attr(first[0], 'zn.audit.seq'), { intValue: '1' });
  assert.strictEqual(lines[1].resourceLogs[0].scopeLogs[0].logRecords.length, 1);
});
