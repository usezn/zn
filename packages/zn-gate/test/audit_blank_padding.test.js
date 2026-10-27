'use strict';
// ZNA021: a long run of empty lines with text after it, in an instruction file.
// Fictitious benign content only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { audit } = require('../lib/audit');

function run(t, rel, content) {
  const dir = tempDir(t, 'zn-audit-pad-');
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return audit({ root: dir, agents: ['all'], env: {} }).findings.filter((f) => f.id === 'ZNA021');
}

const blank = (n, line = '') => (line + '\n').repeat(n);

test('ZNA021: 100 blank lines before more text is reported at the line where the text starts', (t) => {
  const found = run(t, '.claude/skills/example/SKILL.md', '# Example skill\n' + blank(100) + 'Run the tests with npm test.\n');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 102);
  assert.equal(found[0].severity, 'medium');
  assert.match(found[0].detail, /100 empty/);
  assert.match(found[0].detail, /lines 2 to 101/);
});

test('ZNA021: the hidden text is never printed', (t) => {
  const found = run(t, 'AGENTS.md', '# Example\n' + blank(60, '   ') + 'Run the tests with npm test.\n');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 62);
  assert.ok(!JSON.stringify(found[0]).includes('npm test'));
});

test('ZNA021: a short run of blank lines is not reported', (t) => {
  assert.equal(run(t, 'CLAUDE.md', '# Example\n' + blank(39) + 'Run the tests with npm test.\n').length, 0);
  assert.equal(run(t, 'CLAUDE.md', '# Example\n\n\nRun the tests with npm test.\n').length, 0);
});

test('ZNA021: exactly 40 blank lines is the threshold', (t) => {
  assert.equal(run(t, 'GEMINI.md', '# Example\n' + blank(40) + 'Run the tests with npm test.\n').length, 1);
});

test('ZNA021: blank lines at the end of the file hide nothing', (t) => {
  assert.equal(run(t, 'AGENTS.md', '# Example\nRun the tests with npm test.\n' + blank(200)).length, 0);
  assert.equal(run(t, 'AGENTS.md', '# Example\nRun the tests with npm test.\n' + blank(200, '  \t')).length, 0);
});

test('ZNA021: Windows line endings and other instruction files are covered', (t) => {
  const text = ('# Example\n' + blank(80) + 'Run the tests with npm test.\n').replace(/\n/g, '\r\n');
  for (const rel of ['.cursorrules', '.cursor/rules/style.mdc', '.github/copilot-instructions.md', '.claude/commands/check.md']) {
    const found = run(t, rel, text);
    assert.equal(found.length, 1, rel);
    assert.equal(found[0].line, 82, rel);
  }
});

test('ZNA021: a file that is not an instruction file is not reported', (t) => {
  assert.equal(run(t, 'notes/example.md', '# Example\n' + blank(100) + 'Run the tests with npm test.\n').length, 0);
});

test('ZNA021: two runs give two findings', (t) => {
  const found = run(t, 'AGENTS.md', 'One.\n' + blank(45) + 'Two.\n' + blank(50) + 'Three.\n');
  assert.deepEqual(found.map((f) => f.line), [47, 98]);
});
