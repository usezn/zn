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

const REFUSE = /Line 1: the value has an escaped quote; zn cannot shadow it safely\. Store it with `zn secret set API_KEY` and edit the line by hand\./;

async function shadowKeeps(t, line) {
  const { dir, vault, io } = setup(t, [line]);
  const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0, io.stderr.text());
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), before, 'the file is untouched');
  assert.equal(await vault.resolve(dir, '__ZN_API_KEY__'), null, 'nothing is stored');
  return io.stdout.text();
}

test('env shadow: a double-quoted value with an escaped quote is refused whole, with a clear message, and the file is untouched', async (t) => {
  const out = await shadowKeeps(t, LINE);
  assert.match(out, REFUSE);
  assert.equal(out.includes(VALUE), false, 'the value is never printed');
});

test('env shadow: an escaped quote anywhere in the value refuses the line, also after an escaped backslash', async (t) => {
  assert.match(await shadowKeeps(t, 'API_KEY="fake-pass\\\\\\"word-123"'), REFUSE);
  assert.match(await shadowKeeps(t, 'API_KEY="fake-password-1\\""'), REFUSE);
});

test('env shadow: an escaped backslash before the closing quote is stored as written and the whole value is replaced', async (t) => {
  const { dir, vault, io } = setup(t, ['API_KEY="fake-ab-12\\\\"']);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0, io.stderr.text());
  assert.equal(await vault.resolve(dir, '__ZN_API_KEY__'), 'fake-ab-12\\\\');
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /^API_KEY="__ZN_API_KEY__"$/m);
});

test('env shadow: a single-quoted value with a backslash is unchanged behaviour', async (t) => {
  const { dir, vault, io } = setup(t, ["API_KEY='fake-pass\\word-123'"]);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0, io.stderr.text());
  assert.equal(await vault.resolve(dir, '__ZN_API_KEY__'), 'fake-pass\\word-123');
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /^API_KEY='__ZN_API_KEY__'$/m);
});

test('env shadow: an unterminated double quote is refused and the file is untouched', async (t) => {
  const out = await shadowKeeps(t, 'API_KEY="fake-pass-word-123');
  assert.match(out, /multi-line value/);
  assert.equal(out.includes('fake-pass-word-123'), false);
});

test('env shadow: a refused line does not stop the other lines from being shadowed', async (t) => {
  const { dir, vault, io } = setup(t, [LINE, 'OTHER_TOKEN="fake-token-9876"']);
  assert.equal(await cli.dispatch('env', ['shadow'], io), 0, io.stderr.text());
  const text = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.ok(text.includes(LINE), 'the refused line is intact');
  assert.match(text, /^OTHER_TOKEN="__ZN_OTHER_TOKEN__"$/m);
  assert.equal(await vault.resolve(dir, '__ZN_OTHER_TOKEN__'), 'fake-token-9876');
});
