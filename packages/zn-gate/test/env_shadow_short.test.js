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

test('env shadow: a short plain value stays in the file and the message names it, says why and what to do', async (t) => {
  const { dir, io } = setup(t, ['API_KEY=abc123']);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0);
  const out = io.stdout.text();
  assert.match(out, /skipped API_KEY: stays in clear text in the file\. The value is only 6 character\(s\)/);
  assert.match(out, /cannot be told apart from ordinary settings/);
  assert.match(out, /run `zn secret set API_KEY` and put __ZN_API_KEY__ in its place/);
  assert.match(out, /1 value\(s\) stay in clear text in \.env: API_KEY\./);
  assert.equal(out.includes('abc123'), false, 'the value is never printed');
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /API_KEY=abc123/);
});

test('env shadow: mixed file lists every clear-text name, counts match, no value or fragment is printed', async (t) => {
  const long = 'TEST_KEY=zz_fake_0000000000000000000000';
  const { dir, io } = setup(t, ['API_KEY=abc', 'DB_PASSWORD=pw', long, 'PORT=3000']);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0);
  const out = io.stdout.text();
  assert.match(out, /Shadowed 1 value\(s\) in \.env\. The values that moved are in the local vault/);
  assert.doesNotMatch(out, /The file now holds only markers/);
  assert.match(out, /skipped API_KEY: stays in clear text/);
  assert.match(out, /skipped DB_PASSWORD: stays in clear text/);
  assert.match(out, /2 value\(s\) stay in clear text in \.env: API_KEY, DB_PASSWORD\./);
  assert.doesNotMatch(out, /skipped TEST_KEY/);
  for (const frag of ['abc', 'zz_fake', '0000000']) {
    assert.equal(out.replace(/API_KEY/g, '').includes(frag), false, 'no fragment ' + frag);
  }
  const file = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.match(file, /API_KEY=abc$/m);
  assert.match(file, /TEST_KEY=__ZN_TEST_KEY__/);
});

test('env shadow: when nothing moves the clear-text names are still listed', async (t) => {
  const { io } = setup(t, ['API_KEY=abc']);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0);
  const out = io.stdout.text();
  assert.match(out, /nothing to shadow/);
  assert.match(out, /1 value\(s\) stay in clear text in \.env: API_KEY\./);
});

test('env shadow: a URL with a short password is moved whole, named in a note, and never printed', async (t) => {
  const { io } = setup(t, ['DB_URL=pg://u:pw@h']);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0);
  const out = io.stdout.text();
  assert.match(out, /note DB_URL: the password in the URL is only 2 character\(s\) long/);
  assert.doesNotMatch(out, /skipped/);
  assert.equal(out.includes('pg://'), false);
  assert.equal(out.includes('pw@'), false);
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

test('env shadow: the suggested manual name is always a valid vault name (key ending in _digits, multi-line value)', async (t) => {
  const markers = require('../lib/broker/markers');
  const { io } = setup(t, ['API_KEY_1=abc', 'PRIVATE_KEY="line one\nline two"', 'DB_PASS_2=pw']);
  assert.equal(await cli.dispatch('env', ['shadow', '--all'], io), 0);
  const out = io.stdout.text();
  const names = [...out.matchAll(/zn secret set ([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(names.length >= 2, 'suggestions are printed');
  for (const n of names) assert.equal(markers.validateSecretName(n), null, n + ' is accepted by the vault');
  assert.match(out, /run `zn secret set API_KEY_1_VALUE` and put __ZN_API_KEY_1_VALUE__ in its place/);
  assert.equal(out.includes('zn secret set API_KEY_1`'), false);
});

test('env shadow --dry-run says it is a preview and that no value has moved', async (t) => {
  const { dir, io } = setup(t, ['API_KEY=abc', 'TEST_KEY=zz_fake_0000000000000000000000']);
  assert.equal(await cli.dispatch('env', ['shadow', '--dry-run'], io), 0);
  const out = io.stdout.text();
  assert.match(out, /Preview only: no value has moved\. If you run this without --dry-run, 1 value\(s\) would stay in clear text in \.env: API_KEY\./);
  assert.doesNotMatch(out, /\n1 value\(s\) stay in clear text/);
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /TEST_KEY=zz_fake/);
});

test('env shadow: the clear-text summary makes no claim about what the hook counts', async (t) => {
  const { io } = setup(t, ['API_KEY=abc']);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0);
  const out = io.stdout.text();
  assert.doesNotMatch(out, /8 characters or more/);
  assert.match(out, /your agent cannot read this file/);
});

test('env shadow --dry-run with only a short skipped value prints the preview line and writes nothing', async (t) => {
  const { dir, vault, io } = setup(t, ['API_KEY=abc']);
  const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.equal(await cli.dispatch('env', ['shadow', '--dry-run'], io), 0);
  const out = io.stdout.text();
  assert.match(out, /Preview only: no value has moved\. If you run this without --dry-run, 1 value\(s\) would stay in clear text in \.env: API_KEY\./);
  assert.doesNotMatch(out, /\n1 value\(s\) stay in clear text/);
  assert.equal(out.includes('abc'), false, 'the value is never printed');
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), before);
  assert.deepEqual(await vault.listSecrets(), []);
});
