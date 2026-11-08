'use strict';

process.env.ZN_STATS = 'off';

// A value that contains '=' is read and moved whole: the first '=' separates
// the key, the rest belongs to the value.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

const cli = require('../lib/broker/cli');
const d = require('../lib/broker/dotenv');
const { createFakeVault } = require('./helpers/fake_vault');
const { tempDir } = require('./helpers/tmp');

// Fake value, long enough to be moved (MIN_SECRET_LEN), with '=' inside.
const FAKE = 'zz_fake_ab=cd=ef_0000000000';

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

test('dotenv: a value with equals signs keeps every equals sign', () => {
  const { entries } = d.parseDotenv('TOKEN=a=b=c\nexport TOKEN2=a=b=c\nTOKEN3="a=b=c"\nTOKEN4=a=b=c # note\n');
  assert.deepEqual(entries.map((e) => [e.key, e.value]), [
    ['TOKEN', 'a=b=c'], ['TOKEN2', 'a=b=c'], ['TOKEN3', 'a=b=c'], ['TOKEN4', 'a=b=c'],
  ]);
});

test('dotenv: a value that ends in equals signs keeps them', () => {
  const { entries } = d.parseDotenv('TOKEN=abc==\nSECRET==\n');
  assert.deepEqual(entries.map((e) => [e.key, e.value]), [['TOKEN', 'abc=='], ['SECRET', '=']]);
});

test('env shadow: a value with equals signs is moved whole and the file keeps only the marker', async (t) => {
  const dir = tempDir(t, 'zn-eq-');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=' + FAKE + '\n');
  const vault = createFakeVault();
  const io = { cwd: dir, home: dir, vault, stdout: sink(), stderr: sink(), human: true, confirm: async () => true };
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0, io.stderr.text());
  const file = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.equal(file.includes('ab=cd=ef'), false, 'the value is not left in the file');
  assert.match(file, /^TOKEN=__ZN_TOKEN__\n$/);
  assert.equal(await vault.resolve(dir, '__ZN_TOKEN__'), FAKE);
  assert.equal(io.stdout.text().includes('ab=cd=ef'), false, 'the value is never printed');
});
