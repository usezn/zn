'use strict';

// Prints the verdict, rule id and rules version of every case in test/fixtures/tool_guard_parity.json
// as evaluated by lib/guard.js. The Python package prints the same shape from its
// own guard (test/helpers/py_tool_guard.py) and the two must match.
//
// Usage: node test/helpers/export_tool_guard.js [cases.json]

const fs = require('fs');
const path = require('path');
const { checkToolCall, scanToolResult } = require('../../lib/guard');

const file = process.argv[2] || path.join(__dirname, '..', 'fixtures', 'tool_guard_parity.json');
const { calls, results } = JSON.parse(fs.readFileSync(file, 'utf8'));

// Cases with a "$build" key describe structures JSON cannot hold (maps, cycles, bytes).
function build(v) {
  if (!v || typeof v !== 'object' || !v.$build) return v;
  if (v.$build === 'nest') {
    let x = v.leaf;
    for (let i = 0; i < v.levels; i++) x = { a: [x] };
    return x;
  }
  if (v.$build === 'map') return { x: new Map([['k', new Map([['p', v.leaf]])]]) };
  if (v.$build === 'bytes') return { p: Buffer.from(v.leaf) };
  if (v.$build === 'cycle') {
    const d = { k: 'hello' };
    d.self = d;
    const lst = [d];
    lst.push(lst);
    if (v.leaf !== 'hello') d.bad = v.leaf;
    return lst;
  }
  throw new Error('unknown $build ' + v.$build);
}
const pick = (a) => ({ verdict: a.verdict, rule: a.rule, rules_version: a.rules_version });

process.stdout.write(JSON.stringify({
  calls: calls.map((c) => pick(checkToolCall(c.tool, build(c.args)))),
  results: results.map((c) => pick(scanToolResult(build(c.result)))),
}));
