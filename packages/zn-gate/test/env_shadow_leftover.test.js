'use strict';

// zn env shadow: the closing line is only "holds only markers" when every value moved.

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

function setup(t, lines, vault = createFakeVault()) {
  const dir = tempDir(t, 'zn-shadow-left-');
  fs.writeFileSync(path.join(dir, '.env'), lines.join('\n') + '\n');
  const io = { cwd: dir, home: dir, vault, stdout: sink(), stderr: sink(), human: true, confirm: async () => true };
  return { dir, vault, io };
}

test('env shadow: DB_URL with a short password moves the whole URL and the file holds only markers', async (t) => {
  const { dir, io } = setup(t, ['DB_URL=postgres://user:hunter2@host/db']);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0, io.stderr.text());
  const out = io.stdout.text();
  assert.doesNotMatch(out, /shorter than 8 characters/);
  assert.match(out, /The file now holds only markers/);
  assert.doesNotMatch(out, /Still in \.env in plain text/);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8').includes('hunter2'), false);
});

test('env shadow: a skipped value is listed and "only markers" is not printed', async (t) => {
  const { dir, io } = setup(t, ['API_KEY=abcdef123456', 'DB_PASSWORD=short1', 'SESSION_SECRET=abc']);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0, io.stderr.text());
  const out = io.stdout.text();
  assert.doesNotMatch(out, /only markers/);
  assert.match(out, /Shadowed 1 value\(s\) in \.env; the values are in the local vault\./);
  assert.match(out, /Still in \.env in plain text: DB_PASSWORD, SESSION_SECRET\./);
  assert.match(out, /skipped DB_PASSWORD: the value is only 6 character\(s\)/);
  assert.match(out, /skipped SESSION_SECRET: the value is only 3 character\(s\)/);
  const file = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.match(file, /API_KEY=__ZN_API_KEY__/);
  assert.match(file, /DB_PASSWORD=short1/);
});

test('env shadow: a multi-line value that is skipped is listed too', async (t) => {
  const { io } = setup(t, ['API_KEY=abcdef123456', 'PRIVATE_KEY="line one', 'line two"']);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0, io.stderr.text());
  const out = io.stdout.text();
  assert.doesNotMatch(out, /only markers/);
  assert.match(out, /Still in \.env in plain text: PRIVATE_KEY\./);
});

test('env shadow: a value that could not be stored (different one already in the vault) is listed', async (t) => {
  const vault = createFakeVault();
  await vault.setSecret('API_KEY', 'a-different-value-123', { mode: 'env', allowHosts: [], allowCommands: [] });
  const { dir, io } = setup(t, ['API_KEY=abcdef123456', 'OTHER_TOKEN=zzzzzzzz123456'], vault);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0, io.stderr.text());
  const out = io.stdout.text();
  assert.doesNotMatch(out, /only markers/);
  assert.match(out, /Still in \.env in plain text: API_KEY\./);
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /API_KEY=abcdef123456/);
});
