'use strict';

// zn-gate init: the failure helpers (networkFailure, timeoutAdvice, permissionAdvice, permissionFailure),
// with fake values only.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../lib/init-guide');

const { networkFailure, timeoutAdvice, permissionAdvice, permissionFailure } = _internal;
const MANUAL = 'npm install -g zn-gate@0.0.0-test';

for (const code of ['EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH']) {
  test('networkFailure: ' + code + ' in the output counts', () => {
    assert.equal(networkFailure('npm ERR! code ' + code + '\nnpm ERR! host registry.example.invalid', false), true);
  });
}

test('networkFailure: a timed-out flag counts, whatever the output says', () => {
  assert.equal(networkFailure('', true), true);
  assert.equal(networkFailure('something else', 1), true);
});

test('networkFailure: other output, empty or missing output does not count', () => {
  assert.equal(networkFailure('npm ERR! code E404', false), false);
  assert.equal(networkFailure('', false), false);
  assert.equal(networkFailure(undefined, false), false);
  assert.equal(networkFailure(null, undefined), false);
});

test('networkFailure: a code inside a longer word does not count', () => {
  assert.equal(networkFailure('XENOTFOUNDX', false), false);
});

test('timeoutAdvice: the seconds and the manual command are in the text', () => {
  const text = timeoutAdvice(MANUAL, 45000);
  assert.match(text, /longer than 45 seconds/);
  assert.ok(text.includes('    ' + MANUAL + '\n'));
  assert.ok(text.includes('npm ls -g zn-gate'));
  assert.ok(text.endsWith('\n\n'));
});

test('timeoutAdvice: milliseconds are rounded to whole seconds', () => {
  assert.match(timeoutAdvice(MANUAL, 1500), /longer than 2 seconds/);
  assert.match(timeoutAdvice(MANUAL, 1499), /longer than 1 seconds/);
});

test('timeoutAdvice: without a time it names the default of 180 seconds', () => {
  assert.match(timeoutAdvice(MANUAL), /longer than 180 seconds/);
  assert.match(timeoutAdvice(MANUAL, 0), /longer than 180 seconds/);
});

test('permissionAdvice: names the folder and never suggests sudo', () => {
  const text = permissionAdvice({ prefix: '/example/prefix', env: {}, todo: [], shell: '/bin/bash' });
  assert.ok(text.includes('global folder (/example/prefix).'));
  assert.ok(!/sudo/.test(text));
  assert.ok(text.includes(require('../lib/zn-command').cliName('npx') + ' -y zn-gate init'));
});

test('permissionAdvice: without a folder, no parentheses', () => {
  const text = permissionAdvice({ env: {}, todo: [], shell: '/bin/bash' });
  assert.ok(text.includes('global folder.'));
  assert.ok(!text.includes('()'));
});

test('permissionAdvice: lists the agents that still need zn-gate, singular and plural', () => {
  const one = [{ name: 'Codex CLI', steps: [{ needsGlobal: true }] }];
  const two = [...one, { name: 'Cursor', steps: [{ needsGlobal: true }] }];
  const skipped = { name: 'Claude Code', steps: [{}] };
  assert.match(permissionAdvice({ todo: [...one, skipped], shell: '' }), /Codex CLI stays unprotected/);
  const text = permissionAdvice({ todo: [...two, skipped], shell: '' });
  assert.match(text, /Codex CLI, Cursor stay unprotected/);
  assert.ok(!text.includes('Claude Code'));
});

test('permissionAdvice: with nothing listed it speaks of the agents above', () => {
  assert.match(permissionAdvice({ todo: [{ name: 'X', steps: [{}] }], shell: '' }), /the agents above that need it stay unprotected/);
  assert.match(permissionAdvice({ shell: '' }), /the agents above that need it stay unprotected/);
});

test('permissionAdvice: the shell picks the profile file', () => {
  assert.ok(permissionAdvice({ shell: '/usr/bin/zsh' }).includes('>> ~/.zshrc'));
  if (process.platform !== 'darwin') {
    assert.ok(permissionAdvice({ shell: '/bin/bash' }).includes('>> ~/.bashrc'));
    assert.ok(permissionAdvice({ env: { SHELL: '/bin/bash' } }).includes('>> ~/.bashrc'));
  }
  assert.ok(permissionAdvice({ env: { SHELL: '/bin/zsh' } }).includes('>> ~/.zshrc'));
});

const posixOnly = { skip: process.platform === 'win32' };

for (const code of ['EACCES', 'EPERM']) {
  test('permissionFailure: ' + code + ' in the output counts', posixOnly, () => {
    assert.equal(permissionFailure('npm ERR! code ' + code, ''), true);
  });
}

test('permissionFailure: "permission denied" counts in any letter case', posixOnly, () => {
  assert.equal(permissionFailure('mkdir: Permission Denied', ''), true);
});

test('permissionFailure: unrelated output does not count', posixOnly, () => {
  assert.equal(permissionFailure('npm ERR! code E404', ''), false);
  assert.equal(permissionFailure(undefined, undefined), false);
});
