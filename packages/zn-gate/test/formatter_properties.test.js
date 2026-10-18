'use strict';
// Property tests (fast-check) for the report formatters: `zn audit` in text,
// JSON and SARIF, and the SARIF of `zn-gate reach`. Inputs are generated with
// benign strings only (unicode, newlines, quotes, percent signs, colons, very
// long values) and fictitious file names. Each property states what a
// formatter must never do: lose a finding, duplicate one, or print output that
// a parser rejects.

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const report = require('../lib/audit/report');
const { RULES, BY_ID } = require('../lib/audit/rules');
const { toSarif: reachSarif, REACH_RULES } = require('../lib/reach/sarif');

const RUNS = { numRuns: 100 };
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const RULE_IDS = RULES.map((r) => r.id);

const SPECIAL = [
  'plain text',
  'say "hi" and \'bye\'',
  '100% done, 50%25 off',
  'a:b:c, d,e',
  'first line\nsecond line\r\nthird',
  'tab\there',
  'naive cafe é 日本語 \u{1f642}',
  'https://example.com/a?b=c%20d',
  'zn_test_xxxxxxxxxxxxxxxx',
  '%0A%0D%3A%2C literal escapes',
];
const text = fc.oneof(
  { weight: 3, arbitrary: fc.string({ unit: 'grapheme', maxLength: 60 }) },
  { weight: 2, arbitrary: fc.constantFrom(...SPECIAL) },
  { weight: 1, arbitrary: fc.string({ maxLength: 4000 }) },
);
// A file of the checked folder, or a path under the home folder.
const relPath = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 40 }).map((s) => 'agents/' + s);
const homePath = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 40 }).map((s) => '~/' + s);

const auditFinding = fc.record({
  id: fc.constantFrom(...RULE_IDS),
  severity: fc.constantFrom(...SEVERITIES),
  agent: fc.constantFrom('claude', 'codex', 'cursor', 'opencode'),
  file: fc.oneof({ weight: 4, arbitrary: relPath }, { weight: 1, arbitrary: homePath }),
  line: fc.integer({ min: 1, max: 100000 }),
  title: text,
  detail: text,
  evidence: text,
  fix: text,
  references: fc.array(text, { maxLength: 3 }),
});
const auditResult = fc.record({
  root: text,
  files: fc.nat({ max: 500 }),
  agents: fc.array(fc.constantFrom('claude', 'codex'), { maxLength: 2 }),
  truncated: fc.boolean(),
  findings: fc.array(auditFinding, { maxLength: 15 }),
});
const failOn = fc.constantFrom('low', 'medium', 'high', 'critical', 'none');
const meta = fc.record({ toolVersion: fc.constantFrom('1.12.0', '0.0.0-test'), failOn, color: fc.constant(false), displayRoot: text });

const pick = (f) => ({
  id: f.id, severity: f.severity, agent: f.agent, file: f.file, line: f.line,
  title: f.title, detail: f.detail, evidence: f.evidence, fix: f.fix, references: f.references,
});

test('audit JSON parses and its findings equal the input findings, in order', () => {
  fc.assert(fc.property(auditResult, meta, (result, m) => {
    const parsed = JSON.parse(report.toJson(result, m));
    assert.deepEqual(parsed.findings, result.findings.map(pick));
    assert.equal(parsed.summary.findings, result.findings.length);
    const by = parsed.summary.bySeverity;
    assert.equal(by.critical + by.high + by.medium + by.low, result.findings.length);
  }), RUNS);
});

test('audit SARIF parses as 2.1.0, has one result per finding and every ruleId exists', () => {
  fc.assert(fc.property(auditResult, meta, (result, m) => {
    const sarif = JSON.parse(report.toSarif(result, m));
    assert.equal(sarif.version, '2.1.0');
    const run = sarif.runs[0];
    const ruleIds = new Set(run.tool.driver.rules.map((r) => r.id));
    assert.equal(run.results.length, result.findings.length);
    result.findings.forEach((f, i) => {
      const res = run.results[i];
      assert.equal(res.ruleId, f.id);
      assert.ok(ruleIds.has(res.ruleId), 'ruleId ' + res.ruleId + ' missing from rules');
      assert.equal(run.tool.driver.rules[res.ruleIndex].id, f.id);
      assert.equal(res.properties.evidence, f.evidence);
    });
    // Identical findings still get distinct fingerprints: none is merged with another.
    const fps = run.results.map((r) => r.partialFingerprints['znAudit/v1']);
    assert.equal(new Set(fps).size, fps.length);
  }), RUNS);
});

test('audit SARIF artifact locations decode back to the file names', () => {
  fc.assert(fc.property(auditResult, meta, (result, m) => {
    const run = JSON.parse(report.toSarif(result, m)).runs[0];
    result.findings.forEach((f, i) => {
      const loc = run.results[i].locations[0].physicalLocation;
      const rel = f.file.startsWith('~/') ? f.file.slice(2) : f.file;
      assert.equal(decodeURIComponent(loc.artifactLocation.uri), rel);
      assert.equal(loc.region.startLine, f.line);
    });
  }), RUNS);
});

test('audit text output shows each finding exactly once, with its rule id and severity', () => {
  fc.assert(fc.property(auditResult, meta, (result, m) => {
    const out = report.toText(result, m);
    // Output is split on \n only; safeText keeps the finding lines free of raw line breaks.
    const lines = out.split('\n');
    const headers = lines.filter((l) => /^(CRITICAL|HIGH|MEDIUM|LOW) {1,}\S+  /.test(l));
    assert.equal(headers.length, result.findings.length);
    result.findings.forEach((f) => {
      const prefix = f.severity.toUpperCase().padEnd(9) + ' ' + f.id + '  ';
      const count = headers.filter((h) => h.startsWith(prefix)).length;
      const expected = result.findings.filter((g) => g.id === f.id && g.severity === f.severity).length;
      assert.equal(count, expected);
    });
    const fixLines = lines.filter((l) => l.startsWith('          fix: '));
    assert.equal(fixLines.length, result.findings.length);
  }), RUNS);
});

const REACH_KINDS = ['dotenv', 'credential-files', 'environment', 'audit'];
const reachFinding = fc.record({
  kind: fc.constantFrom(...REACH_KINDS),
  section: fc.constantFrom('reach', 'agents', 'project', 'user', 'mcp'),
  id: fc.constantFrom(...RULE_IDS),
  severity: fc.constantFrom('high', 'medium', 'low', 'info'),
  file: fc.oneof({ weight: 4, arbitrary: relPath }, { weight: 1, arbitrary: homePath }),
  line: fc.option(fc.integer({ min: 1, max: 100000 }), { nil: undefined }),
  title: text,
  detail: text,
  fix: text,
});

// The reach rule an input finding should map to, as the formatter names it.
function reachRuleKey(f) {
  if (f.kind === 'audit') return f.id;
  return f.section === 'agents' ? 'agent' : f.kind;
}

test('reach SARIF keeps every non-info finding: as a result (file in the folder) or a notification (home, absolute)', () => {
  fc.assert(fc.property(fc.array(reachFinding, { maxLength: 15 }), (findings) => {
    const sarif = JSON.parse(reachSarif({ findings }, { toolVersion: '1.12.0' }));
    assert.equal(sarif.version, '2.1.0');
    const run = sarif.runs[0];
    const notes = run.invocations[0].toolExecutionNotifications;
    const reportable = findings.filter((f) => f.severity !== 'info');
    assert.equal(run.results.length + notes.length, reportable.length);

    const inFolder = reportable.filter((f) => !/^(?:~\/|\/|[A-Za-z]:[\\/]|\\\\)/.test(f.file));
    assert.equal(run.results.length, inFolder.length);
    inFolder.forEach((f, i) => {
      const expected = reachRuleKey(f);
      const want = REACH_RULES[expected] ? REACH_RULES[expected].id : BY_ID[expected].id;
      assert.equal(run.results[i].ruleId, want);
      const ruleIds = new Set(run.tool.driver.rules.map((r) => r.id));
      assert.ok(ruleIds.has(run.results[i].ruleId));
    });
    const fps = run.results.map((r) => r.partialFingerprints['znReach/v1']);
    assert.equal(new Set(fps).size, fps.length);
  }), RUNS);
});
