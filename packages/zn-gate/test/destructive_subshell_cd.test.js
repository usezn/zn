'use strict';

process.env.ZN_STATS = 'off';

// A cd inside a ( ) group runs in a subshell: it does not move the folder of the commands after the group.
// A cd inside { } runs in the same shell and does move it. Only example paths; nothing is run: only the text is checked.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');

const rule = (cmd) => { const r = checkCommand(cmd); return r.verdict === 'block' ? r.rule.replace('destructive:', '') : 'allow'; };

test('a delete after a subshell cd still runs in the folder the line reached before it', () => {
  assert.equal(rule('cd ~ && (cd /tmp); rm -rf .'), 'rm_root_home');
  assert.equal(rule('cd / && (cd /tmp) && find . -delete'), 'rm_root_home');
  assert.equal(rule('cd ~ && ((cd /tmp)); rm -rf .'), 'rm_root_home');
  assert.equal(rule('cd ~ && (cd /tmp && ls); rm -rf .'), 'rm_root_home');
  assert.equal(rule('cd ~ && (cd /tmp; (cd /var); ls); rm -rf .'), 'rm_root_home');
});

test('inside the group the cd still counts', () => {
  assert.equal(rule('(cd ~; rm -rf .)'), 'rm_root_home');
  assert.equal(rule('(cd /tmp; rm -rf .)'), 'allow');
});

test('a subshell cd into a protected folder does not make the rest of the line protected', () => {
  assert.equal(rule('cd /tmp && (cd ~; ls); rm -rf .'), 'allow');
});

test('a cd inside braces moves the folder of what follows', () => {
  assert.equal(rule('cd ~ && { cd /tmp; }; rm -rf .'), 'allow');
  assert.equal(rule('cd /tmp && { cd ~; }; rm -rf .'), 'rm_root_home');
});

// A ( dropped after a pipe (echo | (cat)) is still a group: its ) must not restore the folder of the group around it.
test('a ( group after a pipe does not end the enclosing subshell early', () => {
  assert.equal(rule('cd /tmp && (cd ~; echo | (cat); rm -rf .)'), 'rm_root_home');
  assert.equal(rule('cd /tmp && (cd ~; echo | ((cat)); rm -rf .)'), 'rm_root_home');
  assert.equal(rule('cd /tmp && (cd ~; echo | (cat | (wc)); rm -rf .)'), 'rm_root_home');
  assert.equal(rule('cd /tmp && (cd ~; echo | (cat); echo | (cat); rm -rf .)'), 'rm_root_home');
  assert.equal(rule('cd /tmp && (cd /var && (cd ~; echo | (cat); rm -rf .))'), 'rm_root_home');
});

test('groups after a pipe keep the normal reading of the subshell folder', () => {
  assert.equal(rule('cd ~ && (cd /tmp; echo | (cat); rm -rf .)'), 'allow');
  assert.equal(rule('cd /tmp && (cd ~; echo | (cat)); rm -rf .'), 'allow');
  assert.equal(rule('cd ~ && (cd /tmp; echo | (cat | (wc))); rm -rf .'), 'rm_root_home');
  assert.equal(rule('cd /tmp && (echo | (cat)); rm -rf .'), 'allow');
});
