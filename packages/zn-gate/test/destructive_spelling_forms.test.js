'use strict';

process.env.ZN_STATS = 'off';

// Spellings of the destructive commands that a shell (bash, PowerShell or cmd.exe) reads the same way as the plain form:
// ANSI-C quoting, default-value expansion, brace lists, PowerShell parameter, variable and call-operator forms, cmd.exe
// rd forms, a download written into a startup file through a glued redirect, a group or an exec descriptor, a download
// run from a group, eval or env -S, interpreters fed by a substitution, chmod modes with leading zeros or symbolic
// clauses, fork bomb variants, and text that echo, printf or a here-string feeds into a shell. One shared list,
// test/fixtures/destructive_spelling_forms.json; the Python check runs the same file
// (packages/zn-gate-py/tests/test_destructive_spelling_forms.py). Each case must get the rule in `expect`; the
// look-alikes that only touch a project folder must stay allowed. Only fake paths and example.com URLs: the strings are
// only read, never run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { checkCommand } = require('../lib/destructive');

const { cases: CASES } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'destructive_spelling_forms.json'), 'utf8'));

function rule(cmd) {
  const r = checkCommand(cmd);
  return r.verdict === 'block' ? r.rule.replace('destructive:', '') : 'allow';
}

test('the shared list has both blocked forms and look-alikes', () => {
  assert.ok(CASES.filter((c) => c.expect !== 'allow').length >= 100);
  assert.ok(CASES.filter((c) => c.expect === 'allow').length >= 40);
});

for (const c of CASES) {
  test(`${c.family}: ${JSON.stringify(c.cmd)} -> ${c.expect}`, () => {
    assert.equal(rule(c.cmd), c.expect, c.cmd);
  });
}

test('many default-value expansions stay bounded', () => {
  const words = Array.from({ length: 40 }, (_, i) => '${V' + i + ':-x' + i + '}').join(' ');
  assert.equal(rule('echo ' + words), 'allow');
  assert.equal(rule('rm -rf ' + words + ' ${LAST:-/home/alice}'), 'rm_root_home');
});

test('a brace list in a command these rules read that expands too far is refused', () => {
  assert.equal(rule('rm -rf ' + '{a,b}'.repeat(12)), 'too_many_commands');
  assert.equal(rule('echo ' + '{a,b}'.repeat(12)), 'allow');
});

// Long inputs aimed at the patterns that once backtracked: each must be read in well under a second.
const LONG = {
  'iex then a run of (': 'iex ' + '('.repeat(20000),
  'iex then a run of ( with blanks': 'iex ' + '( '.repeat(20000),
  'a run of >': 'curl x' + '>'.repeat(20000),
  'rd with a run of /s': 'rd ' + '/s'.repeat(10000) + 'x C:\\ ',
  'many default values': 'rm -rf ' + Array.from({ length: 3000 }, (_, i) => '${V' + i + ':-x}').join(' '),
  'nested script blocks': '& ' + '{ '.repeat(10000) + 'Remove-Item',
  'many groups around a download': '{ curl x; '.repeat(2000) + '}'.repeat(2000) + ' | sh',
  'start with many options': 'start ' + '/b '.repeat(7000) + 'x',
  'many exec descriptors': Array.from({ length: 3000 }, (_, i) => 'exec ' + (i % 9) + '>> ./f').join('; '),
  'a chmod mode with many leading zeros': 'chmod -R ' + '0'.repeat(20000) + 'x /home/alice',
  'a chmod mode with a long run of +': 'chmod -R ' + '+'.repeat(20000) + 'Z ~',
  'many symbolic chmod clauses': 'chmod -R ' + 'o+w,'.repeat(5000) + 'o-w ~',
  'a long function name': 'a'.repeat(20000) + '(){ x; }',
  'many function keywords': 'function f '.repeat(2000) + '{ f|f& }',
  'many function heads with no body': 'f() '.repeat(7000) + '{',
  'a function body that never closes': 'f(){ ' + 'f|f& '.repeat(5000),
  'a long function body': 'f(){ ' + 'f|'.repeat(10000) + 'f& }; f',
  'separators after a function body': 'f(){ f|f& }' + ';'.repeat(20000) + 'g',
  'printf with many arguments into a shell': "printf '%s%s' " + 'a '.repeat(10000) + '| sh',
  'printf with a long format reused into a shell': "printf '" + 'x'.repeat(2000) + "%s' " + 'a '.repeat(10000) + '| sh',
  'printf with a run of zeros in a conversion': "printf '%" + '0'.repeat(20000) + "Z' | sh",
  'echo with many words into a shell': 'echo ' + 'w '.repeat(20000) + '| sh',
  'a long here-string': "sh <<< '" + 'rm '.repeat(7000) + "'",
  'many echo commands in a substitution': 'bash -c "$(' + 'echo x; '.repeat(3000) + ')"',
  'an unclosed substitution in sh -c': 'bash -c "$(' + 'x'.repeat(20000) + '"',
};
for (const [name, text] of Object.entries(LONG)) {
  test(`long input stays fast: ${name}`, () => {
    const t0 = process.hrtime.bigint();
    checkCommand(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1500, `${name} took ${ms.toFixed(0)} ms`);
  });
}
