'use strict';
/*
 * The vault audit check compares the last record the vault remembers
 * (sequence number and MAC) with the log, so a tail lost after a crash is
 * reported, even when the log was appended to afterwards.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const audit = require('../lib/vault/audit');
const { tempDir } = require('./helpers/tmp');

function setup(t, n) {
  const dir = tempDir(t, 'zn-audit-cp-');
  const file = path.join(dir, 'audit.jsonl');
  const key = crypto.randomBytes(32);
  let last;
  for (let i = 0; i < n; i++) last = audit.append({ secret: 'DB_PASSWORD', mode: 'env', decision: 'allow' }, { file, key });
  return { file, key, head: { seq: last.seq, mac: last.mac } };
}

test('a log that matches the checkpoint verifies, and so does one that grew after it', (t) => {
  const { file, key, head } = setup(t, 5);
  assert.deepStrictEqual(audit.verify({ file, key, checkpoint: head }), { ok: true, records: 5 });
  audit.append({ secret: 'DB_PASSWORD', mode: 'env', decision: 'deny' }, { file, key });
  assert.deepStrictEqual(audit.verify({ file, key, checkpoint: head }), { ok: true, records: 6 });
});

test('a lost tail is reported against the checkpoint', (t) => {
  const { file, key, head } = setup(t, 5);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  fs.writeFileSync(file, lines.slice(0, 3).join('\n') + '\n');
  const r = audit.verify({ file, key, checkpoint: head });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /log truncated \(vault expects 5 records\)/);
  assert.strictEqual(audit.verify({ file, key }).ok, true, 'without a checkpoint the shorter chain is valid');
});

test('a lost tail followed by new records that reach the same sequence number is reported by MAC', (t) => {
  const { file, key, head } = setup(t, 5);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  fs.writeFileSync(file, lines.slice(0, 4).join('\n') + '\n');
  // The log is the same length again and its chain is valid, but the last record is another one.
  audit.append({ secret: 'OTHER_KEY', mode: 'env', decision: 'allow' }, { file, key });
  assert.strictEqual(audit.verify({ file, key }).ok, true);
  const r = audit.verify({ file, key, checkpoint: head });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /differs from the vault checkpoint/);
  assert.strictEqual(r.line, 5);
});

test('a missing log with a checkpoint is reported as truncated', (t) => {
  const { file, key, head } = setup(t, 2);
  fs.unlinkSync(file);
  const r = audit.verify({ file, key, checkpoint: head });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /log truncated/);
  assert.strictEqual(audit.verify({ file, key }).ok, true, 'without a checkpoint an absent file is "no log"');
});
