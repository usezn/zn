'use strict';
/**
 * Near-miss negatives for a fake key followed by a hyphenated or dotted word on the next line
 * (`run-deploy`, `config.yaml`). test/fixtures/scrubber_next_line_near_miss.json holds the fake keys in
 * 5-character chunks (assembled here) and, per case, the output each engine gives for the key line alone
 * plus the next line verbatim (ideal_*). node_over / py_over record the cases where the engine still takes
 * part of the next line; a case whose state changes fails here in both directions, so a fix must flip
 * the flag. No key text may ever be left in the output. Python half: tests/test_scrubber_next_line_near_miss.py.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { redactSecrets } = require('../lib/rules');

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'scrubber_next_line_near_miss.json'), 'utf8'));
const assemble = (k) => corpus.keys[k].prefix_chunks.join('') + corpus.keys[k].body_chunks.join('');

test('the near-miss corpus has the expected size and shapes', () => {
  assert.ok(corpus.cases.length >= 1000);
  assert.ok(Object.keys(corpus.keys).length >= 12);
  assert.ok(new Set(corpus.cases.map((c) => c.next)).size >= 14);
});

test('each case matches its recorded state and leaves no key text', () => {
  const wrong = [];
  for (const c of corpus.cases) {
    const line = c.prefix + assemble(c.key);
    const out = redactSecrets(line + c.sep + c.next).sanitized;
    const ideal = redactSecrets(line).sanitized + c.sep + c.next;
    if (ideal !== c.ideal_node) wrong.push(['ideal', c.key, c.next]);
    if ((out !== c.ideal_node) !== c.node_over) wrong.push(['state', c.key, c.next, out]);
    const body = corpus.keys[c.key].body_chunks.join('');
    const lineOut = redactSecrets(line).sanitized;
    for (let i = 0; i + 8 <= body.length; i++) {
      if (lineOut.includes(body.slice(i, i + 8)) && !out.includes(body.slice(i, i + 8))) break;
      if (out.includes(body.slice(i, i + 8)) && !lineOut.includes(body.slice(i, i + 8))) wrong.push(['new_leak', c.key, c.next]);
    }
  }
  assert.deepEqual(wrong.slice(0, 5), []);
});
