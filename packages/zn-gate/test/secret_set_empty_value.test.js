'use strict';
/**
 * `zn secret set NAME` with an empty value (the hidden prompt returns nothing, for example Enter pressed
 * at once) exits 64 (usage), says nothing was stored, and stores nothing. Fake values only.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('stream');

const cli = require('../lib/broker/cli');
const { createFakeVault } = require('./helpers/fake_vault');

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

test('zn secret set with an empty value exits 64, stores nothing and says so', async () => {
  for (const empty of ['', undefined]) {
    const vault = createFakeVault();
    const stderr = sink();
    const io = {
      cwd: process.cwd(), home: process.cwd(), vault, stdout: sink(), stderr, human: true,
      confirm: async () => true, readSecret: async () => empty,
    };
    const code = await cli.dispatch('secret', ['set', 'EMPTY_ONE'], io);
    assert.equal(code, 64, 'exit code for ' + JSON.stringify(empty));
    assert.match(stderr.text(), /empty value, nothing stored/);
    assert.deepEqual(await vault.listSecrets(), [], 'nothing stored for ' + JSON.stringify(empty));
  }
});
