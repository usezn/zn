'use strict';
// Prints, as JSON, what redactSecrets makes of each text in the JSON array file given as the
// argument. Used by packages/zn-gate-py/tests/test_redaction_parity_fuzz.py to compare the
// Node.js and Python redaction on the same seeded random texts.
const fs = require('fs');
const path = require('path');
const { redactSecrets } = require(path.join(__dirname, '..', '..', 'lib', 'rules'));

const texts = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify(texts.map((t) => redactSecrets(t).sanitized)));
