'use strict';

process.env.ZN_STATS = 'off';

// The home-anchored checks (zn state, registry tokens, agent folders) and the agent configuration
// patterns see the lexical view of a path: one representative case per class of spelling.
// Paths are fictitious; the platform is simulated and restored after each block.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const policy = require('../lib/hooks/policy');

const BS = String.fromCharCode(92);
const OPTS = { home: '/home/dev', cwd: '/work/proj', env: {} };

function asPlatform(name, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: name, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', desc);
  }
}

const kindOf = (p, opts = OPTS) => (policy.classifyPath(p, opts) || {}).kind || null;
const toSlash = (p) => p.split(BS).join('/');

test('lexical view: separators, "." and ".." from path.posix and path.win32', () => {
  const posix = path.posix.resolve('/home/dev', 'a' + BS + '..' + BS + '.zn//vault');
  assert.equal(policy._lexicalPath(toSlash(posix), false), '/home/dev/.zn/vault');
  const win = path.win32.resolve('C:' + BS + 'Users' + BS + 'dev', '.zn. ' + BS + 'vault');
  assert.equal(policy._lexicalPath(toSlash(win), true), 'C:/Users/dev/.zn/vault');
  assert.equal(policy._lexicalPath('C:/..', true), 'C:');
});

test('lexical view: trailing dots are kept off Windows', () => {
  assert.equal(policy._lexicalPath('/home/dev/.zn./vault', false), '/home/dev/.zn./vault');
});

test('home-anchored zn state: a ".." written with backslashes', () => {
  assert.equal(kindOf('~/a' + BS + '..' + BS + '.zn/vault'), 'zn_state');
});

test('home-anchored registry token: braced PowerShell home variable', () => {
  assert.equal(kindOf('${env:USERPROFILE}/.npmrc'), 'credential');
});

test('home-anchored zn state: ~name of the current user', () => {
  assert.equal(kindOf('~dev/.zn/vault'), 'zn_state');
  assert.equal(kindOf('~other/.zn/vault'), null);
});

test('Windows: trailing dots and spaces in segments name the same agent settings and zn state', () => {
  asPlatform('win32', () => {
    assert.equal(kindOf('~/.claude./settings.json.'), 'agent_config');
    assert.equal(kindOf('~/.zn /vault'), 'zn_state');
  });
  asPlatform('linux', () => {
    assert.equal(kindOf('~/.claude./settings.json.'), null);
  });
});

test('Gemini CLI and Antigravity folders are agent configuration folders', () => {
  assert.equal(kindOf('~/.gemini'), 'agent_config');
  assert.equal(kindOf('/work/proj/.gemini'), 'agent_config');
});

test('.agents: only the folder itself is protected, not what other tools keep in it', () => {
  assert.equal(kindOf('/work/proj/.agents'), 'agent_config');
  assert.equal(kindOf('/work/proj/.agents/skills'), null);
});
