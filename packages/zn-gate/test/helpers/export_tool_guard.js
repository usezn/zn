'use strict';

// Prints the verdict and rule id of every case in test/fixtures/tool_guard_parity.json
// as evaluated by lib/guard.js. The Python package prints the same shape from its
// own guard (test/helpers/py_tool_guard.py) and the two must match.
//
// Usage: node test/helpers/export_tool_guard.js [cases.json]

const fs = require('fs');
const path = require('path');
const { checkToolCall, scanToolResult } = require('../../lib/guard');

const file = process.argv[2] || path.join(__dirname, '..', 'fixtures', 'tool_guard_parity.json');
const { calls, results } = JSON.parse(fs.readFileSync(file, 'utf8'));
const pick = (a) => ({ verdict: a.verdict, rule: a.rule });

process.stdout.write(JSON.stringify({
  calls: calls.map((c) => pick(checkToolCall(c.tool, c.args))),
  results: results.map((c) => pick(scanToolResult(c.result))),
}));
