'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { uncovered } = require('./run-all.js');

test('the runner guard reports test files that no step runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-runall-'));
  try {
    for (const f of ['a.test.js', 'b.test.mjs', 'c_test.js', 'sub/d.test.cjs', 'integration/test_agent_workflows.js', 'helper.js']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '');
    }
    const none = { plain: [], harness: [], exclude: [] };
    assert.deepStrictEqual(uncovered(dir, none), ['a.test.js', 'b.test.mjs', 'c_test.js', 'sub/d.test.cjs']);
    assert.deepStrictEqual(
      uncovered(dir, { plain: ['c_test.js'], harness: ['a.test.js'], exclude: ['b.test.mjs', 'sub/d.test.cjs'] }),
      []
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
