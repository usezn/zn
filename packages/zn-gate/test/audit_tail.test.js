'use strict';
/*
 * The audit log append reads the last record from the tail of the file.
 * A long run of blank lines before a large record must not make it slow.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tempDir } = require('./helpers/tmp');
const audit = require('../lib/vault/audit');

const KEY = crypto.randomBytes(32);

test('append after trailing blank lines continues the chain', (t) => {
  const file = path.join(tempDir(t, 'zn-audit-tail-'), 'audit.log');
  audit.append({ op: 'get', name: 'A' }, { file, key: KEY });
  fs.appendFileSync(file, '\n\n\n');
  audit.append({ op: 'get', name: 'B' }, { file, key: KEY });
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2);
  const [a, b] = lines.map((l) => JSON.parse(l));
  assert.notStrictEqual(a.mac, undefined);
  assert.strictEqual(b.prev, a.mac);
});

test('a long run of blank lines before a large last record is read quickly', (t) => {
  const file = path.join(tempDir(t, 'zn-audit-tail-'), 'audit.log');
  audit.append({ op: 'get', name: 'A' }, { file, key: KEY });
  const big = JSON.stringify({ filler: 'x'.repeat(70000) });
  fs.appendFileSync(file, '\n'.repeat(300000) + big + '\n');
  const start = process.hrtime.bigint();
  try { audit.append({ op: 'get', name: 'B' }, { file, key: KEY }); } catch (_) { /* only the time matters */ }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 2000, `took ${ms} ms`);
});
