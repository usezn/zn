'use strict';

// zn-gate init (guided setup): the advice printed when npm may not write its global folder.
// It names the right shell profile, shows the folder when known, and names the agents left unprotected.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../lib/init-guide');

const { permissionAdvice } = _internal;

/* Run fn with process.platform set to value, and always put the real value back. */
function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

const globalStep = { steps: [{ needsGlobal: true }] };

test('permissionAdvice: a zsh shell is told to edit ~/.zshrc', () => {
  const text = withPlatform('linux', () => permissionAdvice({ prefix: '', env: {}, todo: [], shell: '/bin/zsh' }));
  assert.match(text, />> ~\/\.zshrc\n/);
  assert.doesNotMatch(text, /\.bashrc/);
});

test('permissionAdvice: a bash shell is told to edit ~/.bashrc', () => {
  const text = withPlatform('linux', () => permissionAdvice({ prefix: '', env: {}, todo: [], shell: '/bin/bash' }));
  assert.match(text, />> ~\/\.bashrc\n/);
  assert.doesNotMatch(text, /\.zshrc/);
});

test('permissionAdvice: the shell is read from SHELL when none is given', () => {
  const text = withPlatform('linux', () => permissionAdvice({ prefix: '', env: { SHELL: '/usr/bin/zsh' }, todo: [] }));
  assert.match(text, />> ~\/\.zshrc\n/);
});

test('permissionAdvice: on macOS ~/.zshrc is used whatever the shell', () => {
  const text = withPlatform('darwin', () => permissionAdvice({ prefix: '', env: {}, todo: [], shell: '/bin/bash' }));
  assert.match(text, />> ~\/\.zshrc\n/);
  assert.doesNotMatch(text, /\.bashrc/);
});

test('permissionAdvice: a known prefix is shown in parentheses', () => {
  const text = permissionAdvice({ prefix: '/example/npm-prefix', env: {}, todo: [], shell: '/bin/bash' });
  assert.match(text, /write to its global folder \(\/example\/npm-prefix\)\.\n/);
});

test('permissionAdvice: no prefix leaves the parentheses out', () => {
  for (const prefix of ['', undefined]) {
    const text = permissionAdvice({ prefix, env: {}, todo: [], shell: '/bin/bash' });
    assert.match(text, /write to its global folder\.\n/);
    assert.doesNotMatch(text, /global folder \(/);
  }
});

test('permissionAdvice: one agent that needs a global install is named with "stays"', () => {
  const todo = [
    { name: 'Codex CLI', ...globalStep },
    { name: 'Claude Code', steps: [{ needsGlobal: false }] },
  ];
  const text = permissionAdvice({ prefix: '', env: {}, todo, shell: '/bin/bash' });
  assert.match(text, /Until zn-gate is installed for your user, Codex CLI stays unprotected\.\n/);
  assert.doesNotMatch(text, /Claude Code/);
});

test('permissionAdvice: several agents are listed with "stay"', () => {
  const todo = [
    { name: 'Codex CLI', ...globalStep },
    { name: 'Cursor', steps: [{ needsGlobal: false }, { needsGlobal: true }] },
  ];
  const text = permissionAdvice({ prefix: '', env: {}, todo, shell: '/bin/bash' });
  assert.match(text, /Until zn-gate is installed for your user, Codex CLI, Cursor stay unprotected\.\n/);
});

test('permissionAdvice: an empty or missing todo uses the generic sentence', () => {
  const generic = '  Until zn-gate is installed for your user, the agents above that need it stay unprotected.\n';
  for (const todo of [[], undefined, [{ name: 'Claude Code', steps: [{ needsGlobal: false }] }]]) {
    const text = permissionAdvice({ prefix: '', env: {}, todo, shell: '/bin/bash' });
    assert.ok(text.includes(generic), 'generic sentence expected for todo ' + JSON.stringify(todo));
  }
});

test('permissionAdvice: the text never suggests sudo and ends with a newline', () => {
  const text = permissionAdvice({ prefix: '/example/npm-prefix', env: {}, todo: [{ name: 'Codex CLI', ...globalStep }], shell: '/bin/zsh' });
  assert.ok(text.endsWith('\n'));
  assert.doesNotMatch(text, /\bsudo\b/);
  assert.match(text, /npm config set prefix ~\/\.npm-global/);
});
