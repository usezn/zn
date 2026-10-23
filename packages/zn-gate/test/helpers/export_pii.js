'use strict';
// Prints, as JSON, the PII spans that the scrubber engine finds in each case of the JSON array file
// given as the argument ([{text, pii}], where pii is the scan option: omitted, false or an object of
// booleans). Used by packages/zn-gate-py/tests/test_pii_parity.py to compare the Node.js and Python
// PII layers on the same inputs. Only PII spans are kept (secret patterns are another layer).
const fs = require('fs');
const path = require('path');
const { scan } = require(path.join(__dirname, '..', '..', 'lib', 'scrub', 'engine'));
const { PII_TYPES, PII_DEFAULTS, SCRUB_RULES_VERSION } = require(path.join(__dirname, '..', '..', 'lib', 'scrub', 'patterns'));

const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const types = new Set(PII_TYPES);
const results = cases.map((c) => {
  const ctx = { exact: false, types };
  if (Object.prototype.hasOwnProperty.call(c, 'pii')) ctx.pii = c.pii;
  return scan(c.text, ctx)
    .filter((s) => s.source === 'pii')
    .map((s) => ({ type: s.type, start: s.start, end: s.end, value: c.text.slice(s.start, s.end) }));
});
process.stdout.write(JSON.stringify({ version: SCRUB_RULES_VERSION, types: PII_TYPES, defaults: PII_DEFAULTS, results }));
