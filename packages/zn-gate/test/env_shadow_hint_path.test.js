'use strict';

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

const cli = require('../lib/broker/cli');
const { pasteablePath } = require('../lib/paste-path');
const { createFakeVault } = require('./helpers/fake_vault');
const { tempDir } = require('./helpers/tmp');

const ANA = 'C:\\Users\\Ana Garcia';

test('pasteablePath: plain names stay bare, spaces are quoted per shell', () => {
  assert.equal(pasteablePath('.env', '/home/ana', '/home/ana', 'linux'), '.env');
  assert.equal(pasteablePath('/home/ana/my app/.env', '/home/ana', '/home/ana', 'linux'), "'my app/.env'");
  assert.equal(pasteablePath("/home/ana/it's/.env", '/home/ana', '/home/ana', 'linux'), `'it'"'"'s/.env'`);
  assert.equal(pasteablePath(ANA + '\\proyecto-demo\\.env', ANA, ANA, 'win32'), '"proyecto-demo\\.env"');
  assert.equal(pasteablePath(ANA + '\\a$b\\.env', ANA, ANA, 'win32'), "'a$b\\.env'");
});

test('pasteablePath: a relative path may climb inside home, never above it', () => {
  assert.equal(pasteablePath('/home/ana/b/.env', '/home/ana/a', '/home/ana', 'linux'), '../b/.env');
  assert.equal(pasteablePath('/home/ana/b c/.env', '/srv/work', '/home/ana', 'linux'), "'/home/ana/b c/.env'");
  assert.equal(
    pasteablePath(ANA + '\\proyecto-demo\\.env', 'C:\\Work', ANA, 'win32'),
    '"' + ANA + '\\proyecto-demo\\.env"');
  assert.equal(pasteablePath('D:\\x\\.env', 'C:\\Work', 'C:\\Users\\Ana', 'win32'), '"D:\\x\\.env"');
});

test('secret import prints a quoted path when the folder has spaces', async (t) => {
  const base = tempDir(t, 'zn-hint-');
  const dir = path.join(base, 'my project');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.env'), 'API_TOKEN=abcdefghij1234567890\n');
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  const io = { cwd: base, home: base, vault: createFakeVault(), stdout: w, stderr: new Writable({ write(_c, _e, cb) { cb(); } }), human: true, confirm: async () => true };
  assert.equal(await cli.dispatch('secret', ['import', path.join('my project', '.env')], io), 0);
  const out = Buffer.concat(chunks).toString('utf8');
  assert.match(out, /zn env shadow 'my project\/\.env'/);
});
