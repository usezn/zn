'use strict';

// Passphrase prompts: input typed or pasted before a prompt appears is kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { getPassphrase } = require('../lib/vault/cli');

function tty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  let written = '';
  output.on('data', (d) => { written += d; });
  return { input, output, written: () => written };
}

test('both lines typed ahead are read by the two prompts', async () => {
  const t = tty();
  t.input.write('fake-pass-12345\nfake-pass-12345\n');
  const p = await getPassphrase([], true, { input: t.input, output: t.output });
  assert.equal(p, 'fake-pass-12345');
  assert.match(t.written(), /Repeat passphrase/);
  assert.doesNotMatch(t.written(), /fake-pass/);
});

test('lines typed after each prompt are read too', async () => {
  const t = tty();
  let sent = 0;
  t.output.on('data', () => {
    // Answer each prompt only once it is on screen.
    const prompts = (t.written().match(/passphrase[^:]*: /gi) || []).length;
    while (sent < prompts) { sent++; t.input.write('fake-pass-67890\n'); }
  });
  assert.equal(await getPassphrase([], true, { input: t.input, output: t.output }), 'fake-pass-67890');
  assert.equal(sent, 2);
});

test('different passphrases are refused with a plain message', async () => {
  const t = tty();
  t.input.write('fake-pass-aaaaa\nfake-pass-bbbbb\n');
  await assert.rejects(getPassphrase([], true, { input: t.input, output: t.output }), /do not match.*run zn unlock again/);
});

test('input closed before the second prompt fails instead of waiting', async () => {
  const t = tty();
  t.input.end('fake-pass-12345\n');
  await assert.rejects(getPassphrase([], true, { input: t.input, output: t.output }), /Cancelled: no passphrase was entered/);
});

test('no terminal: the error says what to do', async () => {
  const input = new PassThrough();
  await assert.rejects(getPassphrase([], false, { input, output: new PassThrough() }), /needs a terminal.*--passphrase-stdin/);
});
