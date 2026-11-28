'use strict';
// Prints, as JSON, what the Node.js package makes of each text in the JSON array file given as the argument:
// [{ sanitized, rules, reach, scrub }] per text, where `sanitized` and `rules` are the redactSecrets output and the
// rule ids of its detections, `reach` the secret types `zn-gate reach --history` counts in the text, and
// `scrub` the text with each span of the scrubber (secrets and personal data) written as [REDACTED_<TYPE>].
// Used by packages/zn-gate-py/tests/test_label_parity.py to compare the names the two packages give the same
// secret (redaction labels, rule ids and reach types).
const fs = require('fs');
const path = require('path');
const lib = path.join(__dirname, '..', '..', 'lib');
const { redactSecrets } = require(path.join(lib, 'rules'));
const engine = require(path.join(lib, 'scrub', 'engine'));
const reach = require(path.join(lib, 'reach', 'history'))._internal;

const texts = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify(texts.map((t) => {
  const r = redactSecrets(t);
  const counts = {};
  reach.scanLine(engine, t, counts, null);
  let scrub = '';
  let last = 0;
  for (const sp of engine.scan(t, { exact: false })) {
    scrub += t.slice(last, sp.start) + (sp.quote || '') + '[REDACTED_' + sp.type + ']' + (sp.quote || '');
    last = sp.end;
  }
  scrub += t.slice(last);
  return { sanitized: r.sanitized, rules: r.detections.map((d) => d.rule), reach: counts, scrub };
})));
