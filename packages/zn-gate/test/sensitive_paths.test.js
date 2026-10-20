'use strict';

// path:sensitive_file on the shared table in fixtures/sensitive_path_cases.json.
// tests/test_sensitive_paths.py checks the same table in the Python package.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { checkToolCall } = require('../lib/guard');
const { sensitivePathView } = require('../lib/rules');

const { cases } = require(path.join(__dirname, 'fixtures', 'sensitive_path_cases.json'));

test('every protected path is blocked; the path rule lets the others pass', () => {
  for (const { path: p, expect } of cases) {
    for (const [tool, args] of [['read_file', { path: p }], ['shell', { command: 'cat ' + p }]]) {
      const res = checkToolCall(tool, args);
      const what = `${tool} ${JSON.stringify(p)}: ${res.verdict} (${res.rule})`;
      if (expect === 'block') {
        assert.strictEqual(res.rule, 'path:sensitive_file', what);
      } else {
        // Other rules may still flag a shell command (for example "cat" of an
        // .env template); this table only checks the path rule.
        assert.notStrictEqual(res.rule, 'path:sensitive_file', what);
        if (tool === 'read_file') assert.strictEqual(res.verdict, 'allow', what);
      }
    }
  }
});

test('the path view is lexical and keeps relative parents', () => {
  assert.strictEqual(sensitivePathView('a/b/../../../c'), '../c');
  assert.strictEqual(sensitivePathView('/../x'), '/x');
  assert.strictEqual(sensitivePathView('C:\\A\\..\\..\\b'), 'c:/b\nc:a....b');
  assert.strictEqual(sensitivePathView('~user/./x//y'), '~/x/y');
});

test('the path view stays linear on long runs', () => {
  const long = '.'.repeat(200000) + 'x ' + '/..'.repeat(50000) + ' ' + '\\'.repeat(100000);
  const t0 = process.hrtime.bigint();
  sensitivePathView(long);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1000);
});
