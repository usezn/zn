'use strict';
/**
 * The vault refuses new secret values under 8 characters. A short value stored by an older version
 * keeps working: it is compared exactly (the whole text, no part of a word) and a short tool output
 * is still scanned for it. Fake values only.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('stream');

const cli = require('../lib/broker/cli');
const runner = require('../lib/hooks/runner');
const E = require('../lib/scrub/engine');
const X = require('../lib/scrub/exact');
const { createFakeVault } = require('./helpers/fake_vault');

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

const LEGACY = { name: 'OLD_PIN', type: 'SECRET', values: ['pin-42'], exactShort: true };

test('validateSecretValue: under 8 characters is refused with a clear message, 8 is fine', () => {
  assert.match(X.validateSecretValue('abc123'), /only 6 character\(s\).*at least 8/);
  assert.match(X.validateSecretValue(''), /only 0 character\(s\)/);
  assert.equal(X.validateSecretValue('abcd1234'), null);
});

test('zn secret set refuses a short value and stores nothing', async () => {
  const vault = createFakeVault();
  const io = { cwd: process.cwd(), home: process.cwd(), vault, stdout: sink(), stderr: sink(), human: true, confirm: async () => true, readSecret: async () => 'abc123' };
  const code = await cli.dispatch('secret', ['set', 'SHORT_ONE'], io);
  assert.notEqual(code, 0);
  assert.match(io.stderr.text(), /only 6 character\(s\).*at least 8.*Nothing stored/s);
  assert.deepEqual(await vault.listSecrets(), []);
  io.readSecret = async () => 'abcd1234';
  assert.equal(await cli.dispatch('secret', ['set', 'LONG_ONE'], io), 0);
  assert.equal((await vault.listSecrets()).length, 1);
});

test('the matcher compares a short value exactly: the whole text, never a part of a word', () => {
  const m = X.buildMatcher([LEGACY]);
  assert.equal(m.shortSize, 1);
  const hit = m.find('pin-42\n');
  assert.equal(hit.length, 1);
  assert.deepEqual([hit[0].start, hit[0].end, hit[0].name], [0, 6, 'OLD_PIN']);
  assert.equal(m.find('  pin-42  ').length, 1);
  for (const text of ['pin-4', 'pin-421', 'xpin-42', 'a pin-42 b', 'the pin-4 and pin-42x']) assert.deepEqual(m.find(text), [], text);
});

test('a short value without the legacy flag (detected or local) is still not matched', () => {
  const m = X.buildMatcher([{ name: 'X', type: 'SECRET', values: ['pin-42'] }, { name: 'Y', type: 'SECRET', value: 'pin-43' }]);
  assert.equal(m.shortSize, 0);
  assert.deepEqual(m.find('pin-42'), []);
  assert.deepEqual(m.find('pin-43'), []);
});

async function post(vault, output) {
  const ev = { event: 'post_tool', tool: 'mcp', toolName: 'mcp__srv__tool', input: {}, output, cwd: process.cwd(), sessionId: 's1' };
  return runner.decidePost(ev, { engine: () => E, vault: async () => vault }, 'claude-code');
}

test('post hook: a short tool output equal to a stored short value is replaced', async () => {
  const vault = createFakeVault();
  vault.exactValues = async () => [LEGACY];
  const r = await post(vault, 'pin-42');
  assert.ok(r.updatedOutput, 'the output was rewritten');
  assert.ok(!JSON.stringify(r.updatedOutput).includes('pin-42'));
  const nested = await post(vault, { a: ['pin-42\n'], b: 'fine' });
  assert.ok(!JSON.stringify(nested.updatedOutput).includes('pin-42'));
  assert.equal(nested.updatedOutput.b, 'fine');
});

test('post hook: short outputs that are not the value pass untouched, also without any short secret', async () => {
  const vault = createFakeVault();
  vault.exactValues = async () => [LEGACY];
  for (const out of ['pin-4', 'ok', 'pin-421']) {
    const r = await post(vault, out);
    assert.equal(r.updatedOutput, undefined, out);
  }
  const plain = createFakeVault();
  plain.exactValues = async () => [];
  const r = await post(plain, 'pin-42');
  assert.equal(r.updatedOutput, undefined);
});
