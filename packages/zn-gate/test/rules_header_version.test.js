'use strict';

// The version named in the header comment of lib/rules.js must equal the RULES_VERSION constant.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'rules.js'), 'utf8');

test('lib/rules.js header names the same RULES_VERSION as the constant', () => {
  const header = src.match(/^\s*\*\s*RULES_VERSION:\s*(\S+)\s*$/m);
  const constant = src.match(/^const RULES_VERSION = '([^']+)';/m);
  assert.ok(header, 'header line " * RULES_VERSION: <version>" not found');
  assert.ok(constant, "constant `const RULES_VERSION = '<version>';` not found");
  assert.equal(header[1], constant[1]);
});
