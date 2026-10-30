'use strict';

// A global npm install (npm, nvm, Homebrew, fnm) puts prefix/bin/<prog> as a link to ../lib/node_modules/<package>/...:
// findProgram must find claude and npm there, as zn-gate 1.13.1 did. The same link into the project's own node_modules
// is the project's and is skipped. Fake files only; nothing is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { findProgram } = require('../lib/exe');
const { tempDir } = require('./helpers/tmp');

const posix = process.platform !== 'win32';

function file(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return p;
}

function link(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at);
}

function project(t) {
  const dir = fs.realpathSync(tempDir(t, 'zn-gnpm-proj-'));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

test('findProgram finds claude and npm of a global npm install (bin links into lib/node_modules)', { skip: !posix }, (t) => {
  const prefix = fs.realpathSync(tempDir(t, 'zn-gnpm-prefix-'));
  file(path.join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
  file(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  link('../lib/node_modules/@anthropic-ai/claude-code/cli.js', path.join(prefix, 'bin', 'claude'));
  link('../lib/node_modules/npm/bin/npm-cli.js', path.join(prefix, 'bin', 'npm'));
  const cwd = project(t);
  const env = { PATH: path.join(prefix, 'bin') + ':/usr/bin:/bin', HOME: '/nonexistent' };
  assert.equal(findProgram('claude', env, cwd), path.join(prefix, 'bin', 'claude'));
  assert.equal(findProgram('npm', env, cwd), path.join(prefix, 'bin', 'npm'));
});

test('findProgram skips a program outside the project that links into the project node_modules', { skip: !posix }, (t) => {
  const cwd = project(t);
  file(path.join(cwd, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
  const bin = path.join(fs.realpathSync(tempDir(t, 'zn-gnpm-bin-')), 'bin');
  link(path.join(cwd, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), path.join(bin, 'claude'));
  const env = { PATH: bin, HOME: '/nonexistent' };
  assert.equal(findProgram('claude', env, cwd), null);
});

test('findProgram still skips a PATH entry that is a node_modules folder (node_modules/.bin)', { skip: !posix }, (t) => {
  const cwd = project(t);
  const other = fs.realpathSync(tempDir(t, 'zn-gnpm-other-'));
  file(path.join(other, 'node_modules', '.bin', 'claude'));
  const env = { PATH: path.join(other, 'node_modules', '.bin'), HOME: '/nonexistent' };
  assert.equal(findProgram('claude', env, cwd), null);
});

test('findProgram strict (the node zn-gate check looks for): a link into any node_modules is skipped, as the plugin does', { skip: !posix }, (t) => {
  const prefix = fs.realpathSync(tempDir(t, 'zn-gnpm-node-'));
  file(path.join(prefix, 'lib', 'node_modules', 'node', 'bin', 'node'));
  link('../lib/node_modules/node/bin/node', path.join(prefix, 'bin', 'node'));
  const cwd = project(t);
  const env = { PATH: path.join(prefix, 'bin'), HOME: '/nonexistent' };
  assert.equal(findProgram('node', env, cwd, { strict: true }), null);
  assert.equal(findProgram('node', env, cwd), path.join(prefix, 'bin', 'node'));
});
