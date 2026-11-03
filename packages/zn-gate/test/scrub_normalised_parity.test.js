'use strict';

// The Python redact_secrets and redact_scan_secrets (tests/test_scrub_shell_split_percent.py) read the same
// fixture: for every case the output of both pairs must be the text in the fixture, character for character.
// Fake values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scan } = require('../lib/scrub/engine');
const { redactSecrets, redactScanSecrets } = require('../lib/rules');

const FIXTURE = path.join(__dirname, 'fixtures', 'scrub_normalised_parity.json');
const cases = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).cases;

test('the fixture has the cases of both kinds', () => {
  assert.ok(cases.length >= 50);
  assert.ok(cases.some((c) => c.output !== c.input));
  assert.ok(cases.some((c) => c.output === c.input));
  assert.ok(cases.every((c) => typeof c.output === 'string'));
});

test('redactSecrets returns the text of the fixture (the Python redact_secrets returns the same)', () => {
  for (const c of cases) {
    assert.equal(redactSecrets(c.input).sanitized, c.output, c.name);
  }
});

test('redactScanSecrets returns the text of the fixture (the Python redact_scan_secrets returns the same)', () => {
  for (const c of cases) {
    assert.equal(redactScanSecrets(c.input).sanitized, c.scan_output === undefined ? c.output : c.scan_output, c.name + ' (scan)');
  }
});

test('the scrubber engine finds a secret in the cases that the scan pair redacts', () => {
  for (const c of cases) {
    const found = scan(c.input, { exact: false }).length > 0;
    assert.equal(found, c.redacted, c.name);
    const scanned = c.scan_output === undefined ? c.output : c.scan_output;
    assert.equal(scanned !== c.input, c.redacted, c.name + ' (scan)');
  }
});
