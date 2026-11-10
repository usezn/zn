'use strict';

// `zn env shadow` rewrites the .env it moves values out of. The rewritten file must keep the
// permission bits of the original file (a 0600 .env stays 0600, a 0640 .env stays 0640).
// Fake values only; the vault is the in-memory fake.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

const cli = require('../lib/broker/cli');
const { createFakeVault } = require('./helpers/fake_vault');
const { tempDir } = require('./helpers/tmp');

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

for (const mode of [0o600, 0o640]) {
  test(`env shadow keeps the .env at mode ${mode.toString(8)} after it rewrites the file`, { skip: process.platform === 'win32' }, async (t) => {
    const dir = tempDir(t, 'zn-shadow-mode-');
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'TEST_KEY=zz_fake_0000000000000000000000\nPORT=3000\n');
    fs.chmodSync(file, mode);
    const io = { cwd: dir, home: dir, vault: createFakeVault(), stdout: sink(), stderr: sink(), human: true, confirm: async () => true };
    assert.equal(await cli.dispatch('env', ['shadow'], io), 0, io.stderr.text());
    assert.match(fs.readFileSync(file, 'utf8'), /TEST_KEY=__ZN_TEST_KEY__/, 'the file was not rewritten');
    assert.equal(fs.statSync(file).mode & 0o777, mode);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.zn-tmp')), [], 'a temporary file was left behind');
  });
}
