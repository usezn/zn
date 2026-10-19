'use strict';

// Every reason `zn-gate check` can give for "NOT protected" is explained in
// docs/check.md. This test reads the messages out of lib/check.js and
// lib/agents/managed-policy.js and fails when the doc lacks one, so the two
// cannot drift apart. A message built from pieces counts as explained when the
// doc quotes each fixed piece (the blanks, such as <file>, stay free).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const checkSrc = fs.readFileSync(path.join(root, 'lib', 'check.js'), 'utf8');
const policySrc = fs.readFileSync(path.join(root, 'lib', 'agents', 'managed-policy.js'), 'utf8');
const docFile = path.join(root, '..', '..', 'docs', 'check.md');
const MIN_LEN = 12;

const squash = (s) => s.replace(/\s+/g, ' ').trim();

/** The fixed text pieces (single-quoted strings) on one line of code. */
function literals(code) {
  const out = [];
  const re = /'((?:[^'\\\n]|\\.)*)'/g;
  let m;
  while ((m = re.exec(code))) out.push(squash(m[1].replace(/\\(.)/g, '$1')));
  return out;
}

/** The source of `function name(...) { ... }`, up to the closing brace at the start of a line. */
function functionBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'lib/check.js has no function ' + name + ': update this test');
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end);
}

function messagePieces() {
  const pieces = new Set();
  // Joining punctuation at the edges of a piece ("), so ...") belongs to the code, not to the message.
  const add = (code) => {
    for (const lit of literals(code)) {
      const p = lit.replace(/^[),;:\s]+/, '').replace(/[(:\s]+$/, '');
      if (p.length >= MIN_LEN && p.includes(' ')) pieces.add(p);
    }
  };

  // lib/check.js: what is put in `problem` and `fix` (the per-agent "not set up" fixes in AGENTS are not reasons).
  for (const line of checkSrc.split('\n')) {
    if (/^\s+fix: /.test(line)) continue;
    if (/(\.(problem|fix)\s*=|\bproblem:|const (RULES_FIX|REINSTALL)\b)/.test(line)) add(line);
  }
  for (const fn of ['runLive', 'pluginNodeProblem', 'pluginNodeStatus']) add(functionBody(checkSrc, fn));

  // lib/agents/managed-policy.js: the settings that turn hooks off (the MCP lists do not decide the verdict).
  for (const line of policySrc.split('\n')) {
    if (/^const ASK_ADMIN\b|^\s*const ask\b|warnings\.push\(/.test(line) && !line.includes('"secrets"') && !/deniedMcp|allowedMcp/.test(line)) add(line);
  }
  return [...pieces].sort();
}

test('the message extractor finds the reasons', () => {
  const pieces = messagePieces();
  assert.ok(pieces.length >= 20, 'found only ' + pieces.length + ' message pieces: has lib/check.js changed shape?');
  assert.ok(pieces.some((p) => p.includes('background')), 'the Codex async reason was not found');
  assert.ok(pieces.some((p) => p.includes('20.12') || p.includes('plugin needs Node.js')), 'the plugin Node.js reason was not found');
});

test('docs/check.md explains every NOT protected reason', (t) => {
  if (!fs.existsSync(docFile)) { t.skip('docs/check.md is not part of this checkout'); return; }
  const doc = squash(fs.readFileSync(docFile, 'utf8'));
  const missing = messagePieces().filter((p) => !doc.includes(p));
  assert.deepEqual(missing, [], 'docs/check.md ("What each NOT protected line means") lacks an entry that quotes these pieces of lib/check.js or lib/agents/managed-policy.js messages. Add the reason with its fix, or reword the doc to quote them exactly:\n  ' + missing.join('\n  '));
});
