'use strict';
/** Report formats of `zn audit`: text, JSON (version 1) and SARIF 2.1.0. */

const crypto = require('crypto');
const { RULES, BY_ID, RANK, SECURITY_SEVERITY } = require('./rules');

const DOCS_URL = 'https://github.com/usezn/zn/blob/main/docs/audit.md';

function summarize(result, failOn) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of result.findings) bySeverity[f.severity]++;
  const failed = failOn !== 'none' && result.findings.some((f) => RANK[f.severity] >= RANK[failOn]);
  return {
    files: result.files,
    findings: result.findings.length,
    bySeverity,
    failOn,
    failed,
    agents: result.agents,
    truncated: Boolean(result.truncated),
  };
}

function toJson(result, meta) {
  return JSON.stringify({
    version: 1,
    tool: 'zn-gate',
    toolVersion: meta.toolVersion,
    root: result.root,
    findings: result.findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      agent: f.agent,
      file: f.file,
      line: f.line,
      title: f.title,
      detail: f.detail,
      evidence: f.evidence,
      fix: f.fix,
      references: f.references,
    })),
    summary: summarize(result, meta.failOn),
  }, null, 2) + '\n';
}

function toText(result, meta) {
  const color = Boolean(meta.color);
  const paint = (code, s) => (color ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s);
  const SEV = { critical: '35;1', high: '31;1', medium: '33', low: '36' };
  const lines = [];
  lines.push('zn audit  ' + meta.displayRoot + '  (zn-gate ' + meta.toolVersion + ')');
  lines.push('');
  for (const f of result.findings) {
    lines.push(paint(SEV[f.severity], f.severity.toUpperCase().padEnd(9)) + ' ' + f.id + '  ' + f.file + ':' + f.line + '  [' + f.agent + ']');
    const pad = '          ';
    lines.push(pad + f.title);
    lines.push(pad + f.detail);
    if (f.evidence) lines.push(pad + paint('90', 'evidence: ' + f.evidence));
    lines.push(pad + paint('90', 'fix: ' + f.fix));
    if (f.references && f.references.length) lines.push(pad + paint('90', 'refs: ' + f.references.join(', ')));
    lines.push('');
  }
  const s = summarize(result, meta.failOn);
  const counts = s.bySeverity;
  const total = s.findings === 1 ? '1 finding' : s.findings + ' findings';
  let tail = total + ' (' + counts.critical + ' critical, ' + counts.high + ' high, ' + counts.medium + ' medium, ' + counts.low + ' low) in ' + s.files + ' file' + (s.files === 1 ? '' : 's') + '.';
  if (meta.failOn === 'none') tail += ' Not failing (--fail-on none).';
  else tail += s.failed ? ' Failing: severity >= ' + meta.failOn + '.' : ' Nothing at or above ' + meta.failOn + '.';
  if (s.findings === 0) tail = 'No findings in ' + s.files + ' agent file' + (s.files === 1 ? '' : 's') + '.';
  lines.push(s.failed ? paint('31;1', tail) : tail);
  if (result.truncated) lines.push('Note: the directory has more entries than zn audit reads; some files were not checked.');
  return lines.join('\n') + '\n';
}

const LEVEL = { critical: 'error', high: 'error', medium: 'warning', low: 'note' };

function encodePath(p) {
  return String(p).split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

function toSarif(result, meta) {
  const rules = RULES.map((r) => ({
    id: r.id,
    name: r.name.replace(/(^|-)([a-z])/g, (m, d, c) => c.toUpperCase()),
    shortDescription: { text: r.title },
    fullDescription: { text: r.help },
    help: {
      text: r.help + '\n\nFix: ' + r.fix + (r.references.length ? '\n\nReferences: ' + r.references.join(', ') : ''),
      markdown: '**' + r.title + '**\n\n' + r.help + '\n\n**Fix:** ' + r.fix + (r.references.length ? '\n\n**References:** ' + r.references.join(', ') : '') + '\n\n[Documentation](' + DOCS_URL + ')',
    },
    helpUri: DOCS_URL + '#rules',
    defaultConfiguration: { level: LEVEL[r.severity] },
    properties: {
      'security-severity': SECURITY_SEVERITY[r.severity],
      precision: 'medium',
      tags: ['security'].concat(r.references),
    },
  }));
  const index = Object.fromEntries(RULES.map((r, i) => [r.id, i]));
  const results = result.findings.map((f) => {
    const home = f.file.startsWith('~/');
    const fp = crypto.createHash('sha256').update([f.id, f.file, f.evidence].join('\u0000')).digest('hex');
    return {
      ruleId: f.id,
      ruleIndex: index[f.id],
      level: LEVEL[f.severity],
      message: { text: f.title + ': ' + f.detail },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: encodePath(home ? f.file.slice(2) : f.file), uriBaseId: home ? 'HOME' : '%SRCROOT%' },
          region: { startLine: f.line },
        },
      }],
      partialFingerprints: { 'znAudit/v1': fp },
      properties: { severity: f.severity, agent: f.agent, evidence: f.evidence, fix: f.fix, references: f.references },
    };
  });
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'zn-gate audit',
          informationUri: DOCS_URL,
          version: meta.toolVersion,
          semanticVersion: meta.toolVersion,
          rules,
        },
      },
      originalUriBaseIds: {
        '%SRCROOT%': { description: { text: 'The audited directory (repository root).' } },
        HOME: { description: { text: 'The user home directory (--include-home).' } },
      },
      columnKind: 'utf16CodeUnits',
      results,
    }],
  }, null, 2) + '\n';
}

module.exports = { toJson, toText, toSarif, summarize, BY_ID };
