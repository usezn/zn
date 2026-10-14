'use strict';
/* OpenTelemetry export of the local audit log (lib/team/otel.js). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tempDir } = require('./helpers/tmp');
const audit = require('../lib/vault/audit');
const { auditToOtlpJsonLines, exportAuditFile } = require('../lib/team/otel');

// Closed attribute lists, copied from the export schema (pinned names only).
const RESOURCE_KEYS = ['service.name', 'service.instance.id', 'service.version', 'zn.org.id'];
const RECORD_KEYS = [
  'event.name', 'zn.decision', 'zn.decision.reason', 'zn.decision.source', 'zn.decision.source_derived',
  'gen_ai.agent.name', 'gen_ai.tool.name', 'process.executable.name', 'server.address', 'server.port',
  'zn.secret.name', 'zn.secret.mode', 'zn.audit.version', 'zn.audit.seq', 'zn.audit.prev', 'zn.audit.mac',
  'zn.rule.id', 'zn.model.score', 'zn.model.threshold', 'zn.model.version', 'zn.rules.version',
  'zn.latency.ms', 'zn.input.sha256', 'zn.input.bytes', 'zn.api_key.id', 'zn.api_key.prefix',
  'zn.client.origin', 'zn.client.name', 'zn.client.version', 'zn.evidence.id', 'user.id',
];
const INT_KEYS = ['server.port', 'zn.audit.version', 'zn.audit.seq', 'zn.input.bytes'];
const HEX_KEYS = ['zn.audit.prev', 'zn.audit.mac', 'zn.input.sha256'];

const INSTALL_ID = '0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const ORG_ID = 'org_acme';

function newLog(t, records) {
  const dir = tempDir(t, 'zn-otel-');
  const file = path.join(dir, 'audit.jsonl');
  const key = crypto.randomBytes(32);
  return { dir, file, key, records };
}

function write(ctx, event) {
  return audit.append(event, { file: ctx.file, key: ctx.key });
}

function parseLines(content) {
  return content.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

function recordsOf(content) {
  const out = [];
  for (const req of parseLines(content)) for (const rl of req.resourceLogs) for (const sl of rl.scopeLogs) out.push(...sl.logRecords);
  return out;
}

function attrMap(rec) {
  const m = {};
  for (const a of rec.attributes) m[a.key] = a.value;
  return m;
}

test('every line parses and has the documented structure', (t) => {
  const ctx = newLog(t);
  write(ctx, { secret: 'DB_PASSWORD', mode: 'env', agent: 'claude-code', tool: 'Bash', argv0: 'psql', decision: 'allow' });
  write(ctx, { secret: 'API_KEY', mode: 'proxy', agent: 'claude-code', tool: 'Bash', host: 'api.example.com', decision: 'deny', reason: 'policy' });
  const out = exportAuditFile({ auditFile: ctx.file, installId: INSTALL_ID, orgId: ORG_ID });
  const lines = parseLines(out.content);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(out.records, 2);
  assert.strictEqual(lines[0].resourceLogs.length, 1);
  const rl = lines[0].resourceLogs[0];
  assert.strictEqual(rl.scopeLogs.length, 1);
  assert.deepStrictEqual(rl.scopeLogs[0].scope, { name: 'usezn.evidence', version: '1' });
  assert.strictEqual(rl.scopeLogs[0].logRecords.length, 2);
  for (const r of rl.scopeLogs[0].logRecords) {
    assert.strictEqual(r.eventName, 'zn.gate.decision');
    assert.strictEqual(r.attributes[0].key, 'event.name');
    assert.strictEqual(r.attributes[0].value.stringValue, 'zn.gate.decision');
  }
});

test('timestamps are nanosecond decimal strings equal to the record time', (t) => {
  const ctx = newLog(t);
  const rec = write(ctx, { decision: 'allow' });
  const out = exportAuditFile({ auditFile: ctx.file });
  const r = recordsOf(out.content)[0];
  const expected = (BigInt(Date.parse(rec.ts)) * 1000000n).toString();
  assert.strictEqual(typeof r.timeUnixNano, 'string');
  assert.match(r.timeUnixNano, /^[0-9]{1,20}$/);
  assert.strictEqual(r.timeUnixNano, expected);
  assert.strictEqual(r.observedTimeUnixNano, expected);
});

test('severity follows the cloud mapping: WARN, ERROR, INFO', (t) => {
  const ctx = newLog(t);
  const cases = [
    ['deny', 'WARN', 13], ['withhold', 'WARN', 13], ['ask:no', 'WARN', 13],
    ['error', 'ERROR', 17],
    ['allow', 'INFO', 9], ['ask:yes', 'INFO', 9], ['ask', 'INFO', 9], ['restore', 'INFO', 9], ['other', 'INFO', 9],
  ];
  for (const [decision] of cases) write(ctx, { decision });
  const recs = recordsOf(exportAuditFile({ auditFile: ctx.file }).content);
  assert.strictEqual(recs.length, cases.length);
  cases.forEach(([decision, text, num], i) => {
    assert.strictEqual(recs[i].severityText, text, decision);
    assert.strictEqual(recs[i].severityNumber, num, decision);
  });
});

test('every attribute key is in the closed schema list and matches its value type', (t) => {
  const ctx = newLog(t);
  write(ctx, { secret: 'DB_PASSWORD', mode: 'env', agent: 'claude-code', tool: 'Bash', argv0: 'psql', host: 'db.example.com:5432', decision: 'deny', reason: 'policy' });
  write(ctx, { secret: 'TOKEN', mode: 'file', decision: 'allow', host: 'api.example.com' });
  const out = exportAuditFile({ auditFile: ctx.file, installId: INSTALL_ID, orgId: ORG_ID });
  for (const req of parseLines(out.content)) {
    for (const a of req.resourceLogs[0].resource.attributes) {
      assert.ok(RESOURCE_KEYS.includes(a.key), a.key);
      assert.strictEqual(typeof a.value.stringValue, 'string');
    }
  }
  for (const r of recordsOf(out.content)) {
    for (const a of r.attributes) {
      assert.ok(RECORD_KEYS.includes(a.key), 'unexpected key ' + a.key);
      if (INT_KEYS.includes(a.key)) assert.match(a.value.intValue, /^-?[0-9]{1,19}$/, a.key);
      else if (HEX_KEYS.includes(a.key)) assert.match(a.value.stringValue, /^[0-9a-f]{64}$/, a.key);
      else assert.strictEqual(typeof a.value.stringValue, 'string', a.key);
    }
  }
});

test('seq, prev and mac are kept as zn.audit.* attributes', (t) => {
  const ctx = newLog(t);
  const first = write(ctx, { decision: 'allow' });
  const second = write(ctx, { decision: 'deny' });
  const recs = recordsOf(exportAuditFile({ auditFile: ctx.file }).content);
  const a1 = attrMap(recs[0]);
  const a2 = attrMap(recs[1]);
  assert.deepStrictEqual(a1['zn.audit.seq'], { intValue: '1' });
  assert.deepStrictEqual(a2['zn.audit.seq'], { intValue: '2' });
  assert.deepStrictEqual(a1['zn.audit.prev'], { stringValue: '0'.repeat(64) });
  assert.deepStrictEqual(a2['zn.audit.prev'], { stringValue: first.mac });
  assert.deepStrictEqual(a2['zn.audit.mac'], { stringValue: second.mac });
  assert.deepStrictEqual(a1['zn.audit.version'], { intValue: '1' });
});

test('export is deterministic: same records, same bytes and SHA-256', (t) => {
  const ctx = newLog(t);
  for (let i = 0; i < 5; i++) write(ctx, { secret: 'DB_PASSWORD', mode: 'env', agent: 'claude-code', tool: 'Bash', decision: i % 2 ? 'deny' : 'allow' });
  const a = exportAuditFile({ auditFile: ctx.file, installId: INSTALL_ID, orgId: ORG_ID });
  const b = exportAuditFile({ auditFile: ctx.file, installId: INSTALL_ID, orgId: ORG_ID });
  assert.strictEqual(a.content, b.content);
  assert.strictEqual(a.sha256, b.sha256);
  assert.strictEqual(a.sha256, crypto.createHash('sha256').update(a.content, 'utf8').digest('hex'));
});

test('1100 records give 3 lines of 500, 500 and 100 records', (t) => {
  const ctx = newLog(t);
  for (let i = 0; i < 1100; i++) write(ctx, { decision: 'allow', tool: 'Bash' });
  const out = exportAuditFile({ auditFile: ctx.file, installId: INSTALL_ID });
  assert.strictEqual(out.records, 1100);
  const lines = parseLines(out.content);
  assert.strictEqual(lines.length, 3);
  assert.deepStrictEqual(lines.map((l) => l.resourceLogs[0].scopeLogs[0].logRecords.length), [500, 500, 100]);
  assert.ok(out.content.endsWith('\n'));
  // Same resource on every line, and the sequence runs straight through.
  const seqs = recordsOf(out.content).map((r) => Number(attrMap(r)['zn.audit.seq'].intValue));
  assert.deepStrictEqual(seqs, Array.from({ length: 1100 }, (_, i) => i + 1));
});

test('an empty or missing log gives no records and an empty content', (t) => {
  const dir = tempDir(t, 'zn-otel-');
  const out = exportAuditFile({ auditFile: path.join(dir, 'missing.jsonl') });
  assert.strictEqual(out.records, 0);
  assert.strictEqual(out.content, '');
  assert.strictEqual(out.sha256, crypto.createHash('sha256').update('', 'utf8').digest('hex'));
  assert.strictEqual(auditToOtlpJsonLines([]), '');
});

test('unparseable lines are skipped', (t) => {
  const ctx = newLog(t);
  write(ctx, { decision: 'allow' });
  write(ctx, { decision: 'deny' });
  fs.appendFileSync(ctx.file, 'not json at all\n{"truncated":\n');
  const out = exportAuditFile({ auditFile: ctx.file });
  assert.strictEqual(out.records, 2);
  assert.strictEqual(recordsOf(out.content).length, 2);
});

test('since keeps only recent records', (t) => {
  const ctx = newLog(t);
  const old = { v: 1, seq: 1, ts: new Date(Date.now() - 30 * 86400000).toISOString(), decision: 'allow', prev: '0'.repeat(64), mac: 'a'.repeat(64) };
  fs.writeFileSync(ctx.file, JSON.stringify(old) + '\n');
  write(ctx, { decision: 'deny' });
  const all = exportAuditFile({ auditFile: ctx.file });
  const recent = exportAuditFile({ auditFile: ctx.file, since: '7d' });
  assert.strictEqual(all.records, 2);
  assert.strictEqual(recent.records, 1);
  assert.strictEqual(attrMap(recordsOf(recent.content)[0])['zn.decision'].stringValue, 'deny');
  const iso = exportAuditFile({ auditFile: ctx.file, since: new Date(Date.now() - 3600000).toISOString() });
  assert.strictEqual(iso.records, 1);
});

test('host is split into server.address and server.port', (t) => {
  const ctx = newLog(t);
  write(ctx, { decision: 'deny', host: 'evil.example.net:8443' });
  const a = attrMap(recordsOf(exportAuditFile({ auditFile: ctx.file }).content)[0]);
  assert.deepStrictEqual(a['server.address'], { stringValue: 'evil.example.net' });
  assert.deepStrictEqual(a['server.port'], { intValue: '8443' });
});

test('a host without a port has no server.port', (t) => {
  const ctx = newLog(t);
  write(ctx, { decision: 'allow', host: 'api.example.com' });
  const a = attrMap(recordsOf(exportAuditFile({ auditFile: ctx.file }).content)[0]);
  assert.deepStrictEqual(a['server.address'], { stringValue: 'api.example.com' });
  assert.strictEqual(a['server.port'], undefined);
});

test('invalid values are dropped, never passed through', (t) => {
  const ctx = newLog(t);
  // Written by hand, so the values reach the mapper unchecked.
  const bad = {
    v: 1, seq: 1, ts: new Date().toISOString(),
    secret: 'db password', mode: 'bogus', agent: 'has spaces', tool: 'Bash;rm',
    argv0: '/usr/bin/psql with args', host: 'Bad Host!', decision: 'bogus',
    reason: 'some free text with spaces', prev: 'xyz', mac: '00',
  };
  fs.writeFileSync(ctx.file, JSON.stringify(bad) + '\n');
  const r = recordsOf(exportAuditFile({ auditFile: ctx.file }).content)[0];
  const a = attrMap(r);
  for (const key of ['zn.decision', 'zn.decision.reason', 'gen_ai.agent.name', 'gen_ai.tool.name',
    'zn.secret.name', 'zn.secret.mode', 'zn.audit.prev', 'zn.audit.mac', 'server.address']) {
    assert.strictEqual(a[key], undefined, key);
  }
  assert.deepStrictEqual(a['gen_ai.tool.name'], undefined);
  assert.strictEqual(r.severityText, 'INFO');
  assert.strictEqual(JSON.stringify(r).includes('free text'), false);
  assert.strictEqual(JSON.stringify(r).includes('db password'), false);
  assert.deepStrictEqual(a['process.executable.name'], undefined);
});

test('the markers [invalid] and [redacted] are kept as markers, as the cloud mapper does', (t) => {
  const ctx = newLog(t);
  write(ctx, { decision: 'deny', reason: '[invalid]', secret: 'TOKEN' });
  const r = recordsOf(exportAuditFile({ auditFile: ctx.file }).content)[0];
  const a = attrMap(r);
  assert.deepStrictEqual(a['zn.decision.reason'], { stringValue: '[invalid]' });
});

test('golden: one record with resource ids and the full attribute list', () => {
  const rec = {
    v: 1, seq: 7, ts: '2026-10-13T10:00:00.000Z',
    secret: 'DB_PASSWORD', mode: 'env', agent: 'claude-code', tool: 'Bash', argv0: 'psql',
    host: 'db.example.com:5432', decision: 'deny', reason: 'policy',
    prev: 'a'.repeat(64), mac: 'b'.repeat(64),
  };
  const content = auditToOtlpJsonLines([rec], { installId: INSTALL_ID, orgId: ORG_ID });
  const expected = {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'zn-gate' } },
          { key: 'service.instance.id', value: { stringValue: INSTALL_ID } },
          { key: 'zn.org.id', value: { stringValue: ORG_ID } },
        ],
      },
      scopeLogs: [{
        scope: { name: 'usezn.evidence', version: '1' },
        logRecords: [{
          timeUnixNano: '1791885600000000000',
          observedTimeUnixNano: '1791885600000000000',
          severityNumber: 13,
          severityText: 'WARN',
          eventName: 'zn.gate.decision',
          body: { stringValue: 'deny agent=claude-code tool=Bash secret=DB_PASSWORD' },
          attributes: [
            { key: 'event.name', value: { stringValue: 'zn.gate.decision' } },
            { key: 'zn.decision', value: { stringValue: 'deny' } },
            { key: 'zn.decision.reason', value: { stringValue: 'policy' } },
            { key: 'gen_ai.agent.name', value: { stringValue: 'claude-code' } },
            { key: 'gen_ai.tool.name', value: { stringValue: 'Bash' } },
            { key: 'process.executable.name', value: { stringValue: 'psql' } },
            { key: 'server.address', value: { stringValue: 'db.example.com' } },
            { key: 'server.port', value: { intValue: '5432' } },
            { key: 'zn.secret.name', value: { stringValue: 'DB_PASSWORD' } },
            { key: 'zn.secret.mode', value: { stringValue: 'env' } },
            { key: 'zn.audit.version', value: { intValue: '1' } },
            { key: 'zn.audit.seq', value: { intValue: '7' } },
            { key: 'zn.audit.prev', value: { stringValue: 'a'.repeat(64) } },
            { key: 'zn.audit.mac', value: { stringValue: 'b'.repeat(64) } },
          ],
        }],
      }],
    }],
  };
  assert.strictEqual(content, JSON.stringify(expected) + '\n');
});

test('without installId or orgId the resource has only service.name', () => {
  const rec = { v: 1, seq: 1, ts: '2026-10-13T10:00:00.000Z', decision: 'allow', prev: '0'.repeat(64), mac: 'c'.repeat(64) };
  const req = parseLines(auditToOtlpJsonLines([rec]))[0];
  assert.deepStrictEqual(req.resourceLogs[0].resource.attributes, [{ key: 'service.name', value: { stringValue: 'zn-gate' } }]);
});
