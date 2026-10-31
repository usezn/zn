'use strict';

// A spread into push() passes every element as an argument, and past about
// 120000 of them it throws RangeError. Lists built from input sizes must be
// filled with loops. Fake values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeToolResult } = require('../lib/rules');
const runner = require('../lib/hooks/runner');

const CAP_MS = 120000;

test('sanitizeToolResult keeps every detection of a string with 200000 secrets', { timeout: CAP_MS }, () => {
  const text = 'AKIAIOSFODNN7EXAMPLE '.repeat(200000);
  const res = sanitizeToolResult({ out: text });
  assert.ok(res.detections.length >= 200000, 'detections: ' + res.detections.length);
  assert.ok(!res.sanitized.out.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('a write with a placeholder and 200000 withheld secrets returns a decision', { timeout: CAP_MS }, async () => {
  const withheld = [];
  for (let i = 0; i < 200000; i++) withheld.push({ token: '__ZN_S' + i + '__', reason: 'policy' });
  const deps = {
    engine: () => ({ detokenize: async (text) => ({ text, restored: [], withheld, notices: [] }) }),
    vault: async () => null,
  };
  const ev = {
    event: 'pre_tool', tool: 'write', toolName: 'Write', cwd: process.cwd(), sessionId: 's1',
    input: { path: path.join(process.cwd(), 'example.txt'), texts: [{ key: 'content', value: 'token __ZN_NAME__ here' }] },
  };
  const r = await runner.decidePre(ev, deps, 'claude-code', { failMode: 'open', home: process.cwd() });
  assert.equal(typeof r.decision, 'string');
});

// Policy lists are bounded by the command size cap, so a huge argument list cannot reach them through a
// command; this keeps new spread pushes out of the three files that build lists from untrusted input.
for (const file of ['lib/hooks/policy.js', 'lib/rules.js', 'lib/hooks/runner.js']) {
  test(file + ' has no push of a spread list', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const hits = src.split(/\r?\n/).filter((l) => /\.push\((?:[^()]*,\s*)?\.\.\./.test(l) && !/^\s*(\/\/|\*)/.test(l));
    // Spreads of a fixed-size literal list are fine; anything else must be a loop.
    const bad = hits.filter((l) => !/\.push\((?:[^()]*,\s*)?\.\.\.\s*(?:new Set\(|\[)/.test(l));
    assert.deepEqual(bad, []);
  });
}
