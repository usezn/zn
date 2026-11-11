'use strict';

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

function setup(t, lines) {
  const dir = tempDir(t, 'zn-escq-');
  fs.writeFileSync(path.join(dir, '.env'), lines.join('\n') + '\n');
  const vault = createFakeVault();
  const io = { cwd: dir, home: dir, vault, stdout: sink(), stderr: sink(), human: true, confirm: async () => true };
  return { dir, vault, io };
}

// The value is fake. In the .env file the double quote inside the value is escaped.
const VALUE = 'fake-pass"word-123';
const LINE = 'API_KEY="fake-pass\\"word-123"';

test('env shadow: a double-quoted value with an escaped quote is stored exactly and the line keeps its quoting', { todo: 'dotenv parser ends a double-quoted value at the escaped quote (\\") and does not unescape it: the stored secret is "fake-pass\\" and the line becomes API_KEY="__ZN_API_KEY__"word-123"' }, async (t) => {
  const { dir, vault, io } = setup(t, [LINE]);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0, io.stderr.text());
  assert.equal(io.stdout.text().includes(VALUE), false, 'the value is never printed');
  assert.equal(await vault.resolve(dir, '__ZN_API_KEY__'), VALUE);
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /^API_KEY="__ZN_API_KEY__"$/m);
});
