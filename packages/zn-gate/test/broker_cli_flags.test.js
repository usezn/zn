'use strict';

// parseFlags and backupName of lib/broker/cli.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseFlags, backupName } = require('../lib/broker/cli');

test('--key=value and --key value give the same result', () => {
  const a = parseFlags(['--mode=env', 'NAME']);
  const b = parseFlags(['--mode', 'env', 'NAME']);
  assert.deepEqual(a, b);
  assert.equal(a.flags.mode, 'env');
  assert.deepEqual(a.positional, ['NAME']);
});

test('a value after = may itself contain =', () => {
  assert.equal(parseFlags(['--type=a=b']).flags.type, 'a=b');
});

test('a repeated plain flag keeps the last value', () => {
  assert.equal(parseFlags(['--mode', 'env', '--mode=file']).flags.mode, 'file');
});

test('repeated multi flags are collected and comma lists are split', () => {
  const { flags } = parseFlags(
    ['--host', 'a.example.com', '--host=b.example.com, c.example.com,', '--host', 'd.example.com'],
    { multi: ['host'] });
  assert.deepEqual(flags.host, ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com']);
});

test('a boolean flag takes no value and leaves the next word positional', () => {
  const { flags, positional } = parseFlags(['--force', 'NAME', '--dry-run'], { bool: ['force', 'dry-run'] });
  assert.equal(flags.force, true);
  assert.equal(flags['dry-run'], true);
  assert.deepEqual(positional, ['NAME']);
});

test('a flag that is not given is absent', () => {
  const { flags } = parseFlags(['NAME'], { bool: ['force'], multi: ['host'] });
  assert.deepEqual(flags, {});
});

test('a missing value is a usage error, for both forms of ending', () => {
  for (const args of [['--mode'], ['NAME', '--host'], ['--mode', 'env', '--host']]) {
    assert.throws(() => parseFlags(args, { multi: ['host'] }), (err) => {
      assert.equal(err.code, 'ZN_USAGE');
      assert.match(err.message, /needs a value/);
      return true;
    });
  }
});

test('an empty value after = is accepted', () => {
  assert.equal(parseFlags(['--mode=']).flags.mode, '');
});

test('backupName is stable for one path and differs for two paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-bak-'));
  try {
    const a = path.join(dir, 'a.env');
    const b = path.join(dir, 'b.env');
    const re = /^ENVBAK_X[0-9A-F]{8}D\d{12}$/;
    assert.match(backupName(a), re);
    // The name ends in a minute-level time stamp, so compare the path part only.
    const id = (f) => backupName(f).slice(0, 'ENVBAK_X'.length + 8);
    assert.equal(id(a), id(a));
    assert.equal(id(a), id(path.join(dir, '.', 'a.env')));
    assert.notEqual(id(a), id(b));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
