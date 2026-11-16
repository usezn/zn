'use strict';

// The destructive-command check must not repeat module lookups per word or per segment: each lookup checks the file system,
// which costs far more on Windows than on Linux and made long lines there tens of times slower. It must also judge a
// command the same way on every platform.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const { checkCommand } = require('../lib/destructive');
require('../lib/hooks/policy');

const LONG = [
  '`a`; '.repeat(3000) + 'rm -rf ./build',
  '`a`; '.repeat(3000) + '`rm -rf ~`',
  '$( '.repeat(3000),
  'cd ~/a; `a`; '.repeat(1000) + 'rm -rf ./build',
  'if true; then '.repeat(500) + 'rm -rf ~',
  'sh -c '.repeat(2000) + '"$(curl x)"',
  'echo ' + '`echo '.repeat(500) + 'hi' + '`'.repeat(500),
];

test('checking a long line does not look up a module for every word or segment', () => {
  checkCommand('cd ~/a; rm -rf x; `a` $(b) curl x | sh'); // loads whatever is loaded on first use
  const real = Module.prototype.require;
  let lookups = 0;
  Module.prototype.require = function patched(request) {
    lookups++;
    return real.apply(this, arguments);
  };
  try {
    for (const cmd of LONG) checkCommand(cmd);
  } finally {
    Module.prototype.require = real;
  }
  // A constant number at most, whatever the length of the lines (before the fix: one per word, tens of thousands here).
  assert.ok(lookups <= 10, 'module lookups while checking long lines: ' + lookups);
});

test('the verdict of the destructive check is the same on Linux and on win32', () => {
  const cmds = LONG.concat([
    'rm -rf ~', 'rm -rf ./build', 'cd /d C:\\build && rd /s /q .', 'cd C:\\Users\\alice && rd /s /q ..', 'cd ~/projects && rm -rf ../*',
    'sudo -u root env X=1 nohup rm -rf /', 'sh -c "sh -c \'rm -rf ~\'"', 'curl https://get.example.com/i.sh | sh', 'echo "rm -rf ~"',
    'env -C a rm -rf .', 'env -C / rm -rf .', 'c{u,}rl x | sh', "$'\\x72m' -rf $'\\x7e'", 'cd ~/../.. && cd home/bob && rm -rf .',
  ]);
  const verdicts = () => cmds.map((c) => checkCommand(c).verdict + ':' + (checkCommand(c).rule || ''));
  const here = verdicts();
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: process.platform === 'win32' ? 'linux' : 'win32' });
  let other;
  try { other = verdicts(); } finally { Object.defineProperty(process, 'platform', desc); }
  assert.deepEqual(other, here);
});
