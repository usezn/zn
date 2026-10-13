'use strict';

// Prints the rule tables and size limits of lib/rules.js as JSON, plus the
// evaluation of every sample in test/fixtures/rules_parity_samples.json.
// The Python package compares this output with its own port of the rules.
//
// Usage: node test/helpers/export_rules.js [samples.json]

const fs = require('fs');
const path = require('path');
const rules = require('../../lib/rules');

function table(list) {
  return list.map((r) => ({ id: r.id, source: r.pattern.source, flags: r.pattern.flags }));
}

function regex(re) {
  return { source: re.source, flags: re.flags };
}

function expandSample(sample) {
  if (typeof sample === 'string') return sample;
  return (sample.prefix || '') + sample.repeat.repeat(sample.times) + (sample.suffix || '');
}

const samplesFile = process.argv[2] || path.join(__dirname, '..', 'fixtures', 'rules_parity_samples.json');
const { samples, redact_samples: redactSamples } = JSON.parse(fs.readFileSync(samplesFile, 'utf8'));

const out = {
  rules_version: rules.RULES_VERSION,
  tables: {
    INJECTION_RULES: table(rules.INJECTION_RULES),
    INDIRECT_INJECTION_RULES: table(rules.INDIRECT_INJECTION_RULES),
    EVASION_RULES: table(rules.EVASION_RULES),
    SENSITIVE_PATH_RULES: table(rules.SENSITIVE_PATH_RULES),
    MARKDOWN_EXFIL_RULES: table(rules.MARKDOWN_EXFIL_RULES),
    SECRET_PATTERNS: table(rules.SECRET_PATTERNS),
  },
  exfil: rules.EXFIL_RULES.map((r) => ({ id: r.id, compound: r.compound.map(regex) })),
  helpers: Object.fromEntries(Object.entries(rules.HELPER_PATTERNS).map(([k, v]) => [k, regex(v)])),
  secret_requires: Object.fromEntries(rules.SECRET_PATTERNS.filter((p) => p.requires).map((p) => [p.id, p.requires])),
  secret_prefilters: Object.fromEntries(rules.SECRET_PATTERNS.filter((p) => p.prefilter).map((p) => [p.id, regex(p.prefilter)])),
  limits: {
    MAX_SCAN_CHARS: rules.MAX_SCAN_CHARS,
    SCAN_HEAD_CHARS: rules.SCAN_HEAD_CHARS,
    SCAN_TAIL_CHARS: rules.SCAN_TAIL_CHARS,
    EVAL_CACHE_MAX_INPUT: rules.EVAL_CACHE_MAX_INPUT,
    MAX_TOOL_RESULT_SCAN_CHARS: rules.MAX_TOOL_RESULT_SCAN_CHARS,
    SCAN_WINDOW_OVERLAP: rules.SCAN_WINDOW_OVERLAP,
    MAX_FILTERED_VALUE: rules.MAX_FILTERED_VALUE,
    MAX_FILTERED_CHARS: rules.MAX_FILTERED_CHARS,
  },
  results: samples.map((sample) => {
    const text = expandSample(sample);
    const res = rules.evaluate(text);
    const { stripped } = rules.normalizeInput(text);
    const scan = rules.scanWindows(text);
    return {
      verdict: res.verdict,
      rule: res.rule,
      truncated: res.truncated === true,
      // The same input scanned as a tool result.
      scan: { verdict: scan.verdict, rule: scan.rule, truncated: scan.truncated === true },
      // Short inputs also compare the normalized text.
      stripped: text.length <= 256 ? stripped : null,
    };
  }),
  redactions: (redactSamples || []).map((sample) => {
    const { sanitized, detections } = rules.redactSecrets(expandSample(sample));
    return { sanitized, rules: detections.map((d) => d.rule) };
  }),
};

process.stdout.write(JSON.stringify(out));
