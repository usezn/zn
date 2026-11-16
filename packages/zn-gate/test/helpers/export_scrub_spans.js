'use strict';
// Prints, as JSON, the secret spans that the scrubber's pattern layer (lib/scrub/patterns.js) finds in each
// text of the JSON array file given as the argument: [[type, start, end], ...] per text. Used by
// packages/zn-gate-py/tests/test_secret_scrub_parity.py to compare the Node.js scrubber and the Python
// redact_secrets on the same fake secrets. Offsets are UTF-16 units; the corpus is ASCII.
const fs = require('fs');
const path = require('path');
const { findPatterns } = require(path.join(__dirname, '..', '..', 'lib', 'scrub', 'patterns'));

const texts = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify(texts.map((t) => findPatterns(t, {}).map((s) => [s.type, s.start, s.end]))));
