'use strict';

// A read-only disk (EROFS) and a missing folder (ENOENT) reach a person in the plain sentences of lib/errors.js,
// the same as in the other commands, never as a raw "EROFS: read-only file system, open ..." message.
// Errors are simulated by stubbing the write calls: no real disk is touched.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { main } = require('../lib/audit/cli');
const { vaultErrorMessage } = require('../lib/vault/cli');
const { tempDir } = require('./helpers/tmp');

const sys = (code, p) => Object.assign(new Error(code + ': simulated, open \'' + p + '\''), { code, errno: code === 'EROFS' ? -30 : -2 });
const RAW = /\b(?:EROFS|ENOENT)\b|read-only file system|no such file/;

async function runApprove(t, failure) {
  const dir = tempDir(t, 'zn-rodisk-');
  const home = tempDir(t, 'zn-rodisk-home-');
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { tools: { command: 'node', args: ['server.js'] } } }));
  const origMkdir = fs.mkdirSync;
  const origWrite = fs.writeFileSync;
  const origRename = fs.renameSync;
  const fail = () => { throw failure; };
  fs.mkdirSync = fail;
  fs.writeFileSync = fail;
  fs.renameSync = fail;
  let err = '';
  try {
    const code = await main([dir, '--approve'], {
      home,
      stdin: { isTTY: true },
      env: {},
      ancestry: () => null,
      accountVault: null,
      stdout: { write() {} },
      stderr: { write: (s) => { err += s; } },
    });
    return { code, err };
  } finally {
    fs.mkdirSync = origMkdir;
    fs.writeFileSync = origWrite;
    fs.renameSync = origRename;
  }
}

test('audit --approve on a read-only disk says so in plain words and exits 2', async (t) => {
  const r = await runApprove(t, sys('EROFS', '/home/example-user/.zn/baselines/x.json'));
  assert.equal(r.code, 2);
  assert.match(r.err, /^zn audit: .+ is on a read-only disk\.\n$/, r.err);
  assert.doesNotMatch(r.err, RAW);
});

test('audit --approve with a missing folder says so in plain words and exits 2', async (t) => {
  const r = await runApprove(t, sys('ENOENT', '/home/example-user/.zn/baselines/x.json'));
  assert.equal(r.code, 2);
  assert.match(r.err, /does not exist, or a folder on its path is missing/, r.err);
  assert.doesNotMatch(r.err, RAW);
});

test('vault: a read-only disk names the vault, not a generic file, and exits through the same message', () => {
  const text = vaultErrorMessage(sys('EROFS', '/home/example-user/.zn/vault/keychain.json'));
  assert.equal(text, 'the vault is on a read-only disk.');
  assert.doesNotMatch(text, RAW);
});

test('vault: a missing folder is said in plain words; a locked-vault error keeps its own text', () => {
  const missing = vaultErrorMessage(sys('ENOENT', '/home/example-user/.zn/vault'));
  assert.match(missing, /^the vault does not exist, or a folder on its path is missing\.$/);
  assert.doesNotMatch(missing, RAW);
  const locked = Object.assign(new Error('Your secret vault is locked.'), { code: 'ZN_LOCKED' });
  assert.match(vaultErrorMessage(locked), /^Your secret vault is locked; run `/);
});
