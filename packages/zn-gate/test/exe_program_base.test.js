'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// programBase is not exported, so load lib/exe.js once more with it added to the exports.
function loadProgramBase() {
  const file = path.join(__dirname, '..', 'lib', 'exe.js');
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.programBase = programBase;\n', file);
  return m.exports.programBase;
}
const programBase = loadProgramBase();

test('programBase drops directory and version suffix', () => {
  assert.equal(programBase('python3.12m'), 'python');
  assert.equal(programBase('/usr/bin/node22'), 'node');
  assert.equal(programBase('C:\\Python\\pythonw.exe'), 'pythonw');
});

test('programBase removes exe, cmd, bat and com extensions and lowercases', () => {
  for (const ext of ['exe', 'cmd', 'bat', 'com']) {
    assert.equal(programBase('Tool.' + ext), 'tool', ext);
    assert.equal(programBase('TOOL.' + ext.toUpperCase()), 'tool', ext);
  }
  assert.equal(programBase('PYTHON3'), 'python');
});

test('programBase does not split a path on whitespace', () => {
  assert.equal(programBase('/opt/My Tools/Node Runner.exe'), 'node runner');
  assert.equal(programBase('C:\\Program Files\\Python\\python.exe'), 'python');
});

test('programBase removes a trailing preview, beta or nightly suffix', () => {
  assert.equal(programBase('tool-preview'), 'tool');
  assert.equal(programBase('tool-beta'), 'tool');
  assert.equal(programBase('tool_nightly'), 'tool');
  assert.equal(programBase('node22-beta'), 'node');
});

test('programBase gives an empty string for empty, undefined and null', () => {
  assert.equal(programBase(''), '');
  assert.equal(programBase(undefined), '');
  assert.equal(programBase(null), '');
});

test('programBase returns a name over 255 characters lowercased and untrimmed, quickly', () => {
  const long = 'A'.repeat(300) + '-beta';
  const start = Date.now();
  assert.equal(programBase(long), long.toLowerCase());
  const digits = '1-'.repeat(5000) + '!';
  assert.equal(programBase(digits), digits);
  assert.ok(Date.now() - start < 1000);
});
