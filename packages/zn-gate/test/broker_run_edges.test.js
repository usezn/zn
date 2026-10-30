'use strict';

// Edges of `zn run` (lib/broker/run.js): argument parsing, exit codes for usage and missing
// programs, and a locked vault with optional environment markers. Fictitious values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Writable } = require('stream');

const { runBroker, parseRunArgs } = require('../lib/broker/run');
const { createFakeVault } = require('./helpers/fake_vault');

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

const NODE = path.basename(process.execPath).replace(/\.exe$/i, '');
const nodeEnv = { PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') };

test('parseRunArgs: --secrets=, short -s, repeated names and --agent', () => {
  assert.deepEqual(parseRunArgs(['--secrets=A_ONE, B_TWO', '--', 'x']), { secrets: ['A_ONE', 'B_TWO'], command: ['x'] });
  assert.deepEqual(parseRunArgs(['-s', 'A_ONE', '-s', 'A_ONE,B_TWO', '--', 'x', '--', 'y']), { secrets: ['A_ONE', 'B_TWO'], command: ['x', '--', 'y'] });
  assert.deepEqual(parseRunArgs(['--agent', 'claude-code', '--', 'x']), { secrets: [], command: ['x'], agent: 'claude-code' });
});

test('parseRunArgs: missing values, bad agent ids, stray arguments and an empty command are usage errors', () => {
  assert.throws(() => parseRunArgs(['--secrets']), (e) => e.code === 'ZN_USAGE');
  assert.throws(() => parseRunArgs(['-s', '', '--', 'x']), (e) => e.code === 'ZN_USAGE');
  assert.throws(() => parseRunArgs(['--agent']), (e) => e.code === 'ZN_USAGE' && /invalid --agent/.test(e.message));
  assert.throws(() => parseRunArgs(['--agent', 'Not Valid!', '--', 'x']), /invalid --agent/);
  assert.throws(() => parseRunArgs(['--agent', 'a'.repeat(33), '--', 'x']), /invalid --agent/);
  assert.throws(() => parseRunArgs(['--bogus', '--', 'x']), /unexpected argument before --: --bogus/);
  assert.throws(() => parseRunArgs(['--']), (e) => e.code === 'ZN_USAGE');
  assert.throws(() => parseRunArgs([]), (e) => e.code === 'ZN_USAGE');
  assert.throws(() => parseRunArgs(['--secrets', 'has space', '--', 'x']), /invalid secret name/);
});

test('runBroker: a usage error exits 64 and writes one line to stderr', async () => {
  const stderr = sink();
  const code = await runBroker(['--secrets', 'A_ONE'], { env: nodeEnv, stdout: sink(), stderr });
  assert.equal(code, 64);
  assert.match(stderr.text(), /^zn run: /);
});

test('runBroker: a program that is not installed exits 127', async () => {
  const stderr = sink();
  const code = await runBroker(['--', 'zn-no-such-program-' + process.pid], { env: nodeEnv, stdout: sink(), stderr });
  assert.equal(code, 127);
  assert.match(stderr.text(), /zn run: /);
});

test('runBroker: an optional environment marker with a locked vault runs the program without secrets and says how to unlock', async () => {
  const vault = createFakeVault();
  const locked = () => { const e = new Error('locked'); e.code = 'ZN_LOCKED'; throw e; };
  vault.listSecrets = async () => locked();
  vault.resolve = async () => locked();
  const stdout = sink();
  const stderr = sink();
  const env = { ...nodeEnv, DEMO_DB: '__ZN_DEMO_DB__' };
  const code = await runBroker(['--', NODE, '-e', 'console.log("ran:" + process.env.DEMO_DB)'], { vault, env, stdout, stderr, stdin: { isTTY: false } });
  assert.equal(code, 0, stderr.text());
  assert.match(stderr.text(), /vault is locked, so secrets were not filled in/);
  assert.match(stdout.text(), /ran:__ZN_DEMO_DB__/, 'the marker is left as is');
});

test('runBroker: a locked vault with a required marker is an error, not a silent pass-through', async () => {
  const vault = createFakeVault();
  const locked = () => { const e = new Error('locked'); e.code = 'ZN_LOCKED'; throw e; };
  vault.listSecrets = async () => locked();
  vault.resolve = async () => locked();
  const stdout = sink();
  const stderr = sink();
  const code = await runBroker(['--secrets', 'DEMO_DB', '--', NODE, '-e', 'console.log("should not run")'], { vault, env: nodeEnv, stdout, stderr, stdin: { isTTY: false } });
  assert.notEqual(code, 0);
  assert.ok(!stdout.text().includes('should not run'));
});
