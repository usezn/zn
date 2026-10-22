'use strict';
/*
 * OpenTelemetry export of the local audit log (lib/team/otel.js): what an
 * exported event looks like, that no secret or file content can reach it, that
 * the export never touches the network, and the limits on its size and on
 * damaged input.
 *
 * The export is a pure function of the audit file, written as OTLP/JSON lines.
 * It has no endpoint and sends nothing, so "endpoint missing or unreachable"
 * is covered as "the export works with every network function broken".
 * Shape and schema are covered in team_otel.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-otel-priv-')));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
process.env.XDG_CONFIG_HOME = path.join(ROOT, 'config');
process.env.ZN_HOME = path.join(ROOT, '.zn');

const { auditToOtlpJsonLines, exportAuditFile } = require('../lib/team/otel');

const IS_WIN = process.platform === 'win32';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const FAKE_SECRET = 'sk-test-FAKE';
const FILE_CONTENT = ['-----BEGIN PRIVATE KEY-----', 'DB_PASSWORD=hunter2-FAKE', 'contents of /home/example/notes.txt'];
const INSTALL_ID = '0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

const parse = (content) => content.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const attrMap = (rec) => Object.fromEntries(rec.attributes.map((a) => [a.key, a.value.stringValue !== undefined ? a.value.stringValue : a.value.intValue]));

function record(extra) {
  return Object.assign({
    v: 1, seq: 1, ts: '2026-10-13T09:00:00.000Z', secret: 'API_KEY', mode: 'proxy', agent: 'claude-code',
    tool: 'Bash', argv0: 'curl', host: 'api.example.com:443', decision: 'allow', reason: 'policy:allow',
    prev: '0'.repeat(64), mac: 'a'.repeat(64),
  }, extra);
}

test('an evidence event becomes one log record with the documented shape and nothing else', () => {
  const out = parse(auditToOtlpJsonLines([record()], { installId: INSTALL_ID, orgId: 'org_acme' }));
  assert.strictEqual(out.length, 1);
  const req = out[0];
  assert.deepStrictEqual(Object.keys(req), ['resourceLogs']);
  const rl = req.resourceLogs[0];
  assert.deepStrictEqual(Object.keys(rl), ['resource', 'scopeLogs']);
  assert.deepStrictEqual(rl.resource.attributes.map((a) => a.key), ['service.name', 'service.instance.id', 'zn.org.id']);
  assert.deepStrictEqual(rl.scopeLogs[0].scope, { name: 'usezn.evidence', version: '1' });
  const rec = rl.scopeLogs[0].logRecords[0];
  assert.deepStrictEqual(Object.keys(rec).sort(), ['attributes', 'body', 'eventName', 'observedTimeUnixNano', 'severityNumber', 'severityText', 'timeUnixNano']);
  assert.strictEqual(rec.eventName, 'zn.gate.decision');
  assert.strictEqual(rec.body.stringValue, 'allow agent=claude-code tool=Bash secret=API_KEY');
  assert.deepStrictEqual(attrMap(rec), {
    'event.name': 'zn.gate.decision', 'zn.decision': 'allow', 'zn.decision.reason': 'policy:allow',
    'gen_ai.agent.name': 'claude-code', 'gen_ai.tool.name': 'Bash', 'process.executable.name': 'curl',
    'server.address': 'api.example.com', 'server.port': '443', 'zn.secret.name': 'API_KEY', 'zn.secret.mode': 'proxy',
    'zn.audit.version': '1', 'zn.audit.seq': '1', 'zn.audit.prev': '0'.repeat(64), 'zn.audit.mac': 'a'.repeat(64),
  });
});

test('fields the schema does not list never reach the output, whatever they hold', () => {
  const rec = record({
    value: FAKE_SECRET, secret_value: FAKE_SECRET, token: FAKE_SECRET, env: { API_KEY: FAKE_SECRET },
    command: 'curl -H "Authorization: Bearer ' + FAKE_SECRET + '" https://api.example.com',
    argv: ['curl', '-H', FAKE_SECRET], output: FAKE_SECRET, content: FILE_CONTENT.join('\n'),
    file_content: FILE_CONTENT, path: '/home/example/notes.txt', body: FILE_CONTENT[1], hash: 'b'.repeat(64),
  });
  const text = auditToOtlpJsonLines([rec], { installId: INSTALL_ID, orgId: 'org_acme' });
  assert.ok(text.length > 0);
  for (const bad of [FAKE_SECRET, 'FAKE', 'hunter2', 'BEGIN PRIVATE KEY', 'notes.txt', 'Authorization', 'Bearer', 'b'.repeat(64)]) {
    assert.ok(!text.includes(bad), 'output must not contain ' + bad);
  }
  const keys = Object.keys(attrMap(parse(text)[0].resourceLogs[0].scopeLogs[0].logRecords[0]));
  assert.ok(!keys.some((k) => /value|token|env|command|argv|output|content|path|hash/.test(k) && k !== 'zn.audit.prev'), keys.join(','));
});

test('a secret or file content placed in a field that is listed is dropped, because it does not match the field format', () => {
  const dirty = FAKE_SECRET + ' ' + FILE_CONTENT[1];
  const rec = record({
    secret: dirty, mode: dirty, agent: dirty, tool: dirty, argv0: dirty, host: dirty + ':443',
    decision: dirty, reason: dirty, prev: dirty, mac: dirty,
  });
  const text = auditToOtlpJsonLines([rec], { installId: dirty, orgId: dirty });
  for (const bad of [FAKE_SECRET, 'hunter2', 'DB_PASSWORD']) assert.ok(!text.includes(bad), bad);
  const log = parse(text)[0].resourceLogs[0];
  assert.deepStrictEqual(log.resource.attributes.map((a) => a.key), ['service.name'], 'bad ids are left out');
  assert.deepStrictEqual(attrMap(log.scopeLogs[0].logRecords[0]), { 'event.name': 'zn.gate.decision', 'zn.audit.version': '1', 'zn.audit.seq': '1' });
  assert.strictEqual(log.scopeLogs[0].logRecords[0].body.stringValue, 'event');
});

test('the export reads the audit file only, and file content that is not an audit line is skipped', (t) => {
  const file = path.join(ROOT, 'mixed-audit.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify(record({ seq: 1 })),
    FILE_CONTENT.join('\n'),
    FAKE_SECRET,
    JSON.stringify({ not: 'a record', ts: 'not a date', value: FAKE_SECRET }),
    JSON.stringify(record({ seq: 2 })),
  ].join('\n') + '\n');
  t.after(() => fs.rmSync(file, { force: true }));
  const r = exportAuditFile({ auditFile: file, installId: INSTALL_ID });
  assert.strictEqual(r.records, 2);
  assert.ok(!r.content.includes(FAKE_SECRET) && !r.content.includes('hunter2'));
});

test('the export has no network code and works with every network function broken', async () => {
  const src = fs.readFileSync(require.resolve('../lib/team/otel'), 'utf8');
  assert.ok(!/require\(['"](node:)?(http|https|http2|net|tls|dgram|dns|child_process)['"]\)/.test(src), 'otel.js must not load a network module');
  assert.ok(!/\bfetch\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'otel.js must not call fetch');
  const real = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network is off'); };
  const net = require('net');
  const realConnect = net.connect;
  net.connect = () => { throw new Error('network is off'); };
  try {
    const t0 = process.hrtime.bigint();
    const out = auditToOtlpJsonLines([record()], { installId: INSTALL_ID });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(out.length > 0);
    assert.ok(ms < 1000, 'export does not wait on anything: ' + ms + ' ms');
  } finally { globalThis.fetch = real; net.connect = realConnect; }
});

test('batch limit: 500 records per line, exactly at and one past the limit', () => {
  const make = (n) => Array.from({ length: n }, (_, i) => record({ seq: i + 1 }));
  const counts = (n) => parse(auditToOtlpJsonLines(make(n))).map((l) => l.resourceLogs[0].scopeLogs[0].logRecords.length);
  assert.deepStrictEqual(counts(499), [499]);
  assert.deepStrictEqual(counts(500), [500]);
  assert.deepStrictEqual(counts(501), [500, 1]);
  assert.deepStrictEqual(counts(1000), [500, 500]);
  assert.deepStrictEqual(counts(1001), [500, 500, 1]);
  // Records stay in seq order across the batches, whatever order they came in.
  const shuffled = make(1200).reverse();
  const seqs = parse(auditToOtlpJsonLines(shuffled)).flatMap((l) => l.resourceLogs[0].scopeLogs[0].logRecords.map((r) => Number(attrMap(r)['zn.audit.seq'])));
  assert.deepStrictEqual(seqs, Array.from({ length: 1200 }, (_, i) => i + 1));
});

test('a batch line stays small, and a huge field cannot enlarge it', () => {
  const huge = 'x'.repeat(2 * 1024 * 1024);
  const recs = Array.from({ length: 500 }, (_, i) => record({ seq: i + 1, reason: huge, host: huge, tool: huge, content: huge }));
  const text = auditToOtlpJsonLines(recs, { installId: INSTALL_ID });
  const line = text.split('\n')[0];
  assert.ok(line.length < 512 * 1024, 'a full line is under 512 KiB: ' + line.length);
});

test('a large log exports in bounded time', (t) => {
  const file = path.join(ROOT, 'large-audit.jsonl');
  const lines = [];
  for (let i = 1; i <= 20000; i++) lines.push(JSON.stringify(record({ seq: i })));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  t.after(() => fs.rmSync(file, { force: true }));
  const t0 = Date.now();
  const r = exportAuditFile({ auditFile: file });
  assert.strictEqual(r.records, 20000);
  assert.strictEqual(r.content.split('\n').filter(Boolean).length, 40);
  assert.ok(Date.now() - t0 < 10000, 'took ' + (Date.now() - t0) + ' ms');
});

test('a missing audit file or folder is an empty export, not an error', () => {
  for (const auditFile of [path.join(ROOT, 'nope.jsonl'), path.join(ROOT, 'no-such-dir', 'a', 'audit.jsonl')]) {
    const r = exportAuditFile({ auditFile });
    assert.deepStrictEqual(r, { content: '', records: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
  }
  // Without a path, the default is the audit file under ZN_HOME (a temp folder here), also missing.
  assert.strictEqual(exportAuditFile({}).records, 0);
});

test('an audit file that cannot be read is an error with the system code, not a silent empty export', { skip: IS_WIN ? 'chmod does not block reads on Windows' : IS_ROOT ? 'root ignores file permissions' : false }, (t) => {
  const file = path.join(ROOT, 'locked-audit.jsonl');
  fs.writeFileSync(file, JSON.stringify(record()) + '\n');
  fs.chmodSync(file, 0o000);
  t.after(() => { try { fs.chmodSync(file, 0o600); fs.rmSync(file, { force: true }); } catch (e) { /* gone */ } });
  assert.throws(() => exportAuditFile({ auditFile: file }), (e) => e.code === 'EACCES');
});

test('a path that is a folder is an error with the system code', () => {
  const dir = path.join(ROOT, 'a-folder');
  fs.mkdirSync(dir, { recursive: true });
  assert.throws(() => exportAuditFile({ auditFile: dir }), (e) => e.code === 'EISDIR' || e.code === 'EPERM' || e.code === 'EACCES');
});

test('a bad since value is refused with a plain message, and a valid one filters', (t) => {
  const file = path.join(ROOT, 'since-audit.jsonl');
  fs.writeFileSync(file, JSON.stringify(record({ ts: '2020-01-01T00:00:00.000Z' })) + '\n' + JSON.stringify(record({ seq: 2, ts: new Date().toISOString() })) + '\n');
  t.after(() => fs.rmSync(file, { force: true }));
  assert.throws(() => exportAuditFile({ auditFile: file, since: 'last week' }), /^Error: invalid since: last week$/);
  assert.strictEqual(exportAuditFile({ auditFile: file, since: '1d' }).records, 1);
  assert.strictEqual(exportAuditFile({ auditFile: file }).records, 2);
});
