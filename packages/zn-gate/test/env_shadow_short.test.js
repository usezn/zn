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
  const dir = tempDir(t, 'zn-short-');
  fs.writeFileSync(path.join(dir, '.env'), lines.join('\n') + '\n');
  const vault = createFakeVault();
  const io = { cwd: dir, home: dir, vault, stdout: sink(), stderr: sink(), human: true, confirm: async () => true };
  return { dir, vault, io };
}

test('env shadow: a long URL with a short password moves the whole URL and says so', async (t) => {
  const url = 'postgres://user:hunter2@db.example.com/app';
  const { dir, vault, io } = setup(t, ['DATABASE_URL=' + url]);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0, io.stderr.text());
  const out = io.stdout.text();
  assert.match(out, /note DATABASE_URL: the password in the URL is only 7 character\(s\) long, so the whole URL was moved/);
  assert.doesNotMatch(out, /shorter than 8 characters/);
  const file = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.equal(file.includes('hunter2'), false, 'the password is not left in the file');
  assert.match(file, /DATABASE_URL=__ZN_DATABASE_URL__/);
  assert.equal(await vault.resolve(dir, '__ZN_DATABASE_URL__'), url);
});

test('env shadow: a short plain value stays in the file and the message says why and what to do', async (t) => {
  const { dir, io } = setup(t, ['API_KEY=abc123']);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0);
  const out = io.stdout.text();
  assert.match(out, /skipped API_KEY: the value is only 6 character\(s\); values under 8 are not moved/);
  assert.match(out, /stays in the file in plain text/);
  assert.match(out, /Use a longer value/);
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /API_KEY=abc123/);
});

test('env shadow: a normal value and a long password move as before', async (t) => {
  const { dir, vault, io } = setup(t, ['API_KEY=abcdef123456', 'DATABASE_URL=postgres://user:correct-horse-9@db.example.com/app']);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0);
  assert.doesNotMatch(io.stdout.text(), /note |skipped /);
  const names = (await vault.listSecrets()).map((s) => s.name).filter((n) => !n.startsWith('ENVBAK_')).sort();
  assert.deepEqual(names, ['API_KEY', 'DATABASE_URL_PASSWORD']);
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /postgres:\/\/user:__ZN_DATABASE_URL_PASSWORD__@db\.example\.com\/app/);
});

test('env shadow --dry-run reports the whole-URL move; secret import prints the note and leaves the file', async (t) => {
  const { dir, io } = setup(t, ['DATABASE_URL=postgres://user:hunter2@db.example.com/app']);
  const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.equal(await cli.dispatch('env', ['shadow', '--dry-run'], io), 0);
  assert.match(io.stdout.text(), /DATABASE_URL -> __ZN_DATABASE_URL__/);
  assert.match(io.stdout.text(), /note DATABASE_URL/);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), before);
  const io2 = { ...io, stdout: sink(), stderr: sink() };
  assert.equal(await cli.dispatch('secret', ['import', '.env'], io2), 0);
  assert.match(io2.stdout.text(), /Imported 1 secret\(s\).*DATABASE_URL/);
  assert.match(io2.stdout.text(), /note DATABASE_URL/);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), before);
});
