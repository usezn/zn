'use strict';
/*
 * How the managed Claude Code settings file is read when its bytes are
 * unusual: a UTF-8 byte order mark, CRLF line endings, no final newline, or
 * no content at all. (zn team managed-config only prints files; the reader is
 * lib/agents/managed-policy.js.)
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { claudeCodePolicyWarnings } = require('../lib/agents/managed-policy');

const OFF = { disableAllHooks: true };

function warningsFor(t, bytes) {
  const dir = path.join(tempDir(t, 'zn-mshape-'), 'managed');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'managed-settings.json'), bytes);
  return claudeCodePolicyWarnings({ managedDir: dir, userSettings: [], mcp: false });
}

const pretty = JSON.stringify(OFF, null, 2);

test('a UTF-8 byte order mark is ignored', (t) => {
  const w = warningsFor(t, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(pretty + '\n')]));
  assert.equal(w.length, 1);
  assert.match(w[0], /turns off all hooks/);
});

test('CRLF line endings are read', (t) => {
  const w = warningsFor(t, pretty.replace(/\n/g, '\r\n') + '\r\n');
  assert.equal(w.length, 1);
  assert.match(w[0], /turns off all hooks/);
});

test('a missing final newline is read', (t) => {
  const w = warningsFor(t, pretty);
  assert.equal(w.length, 1);
  assert.match(w[0], /turns off all hooks/);
});

test('a 0-byte file gives no warning', (t) => {
  assert.deepEqual(warningsFor(t, ''), []);
});

test('a file with only a byte order mark gives no warning', (t) => {
  assert.deepEqual(warningsFor(t, Buffer.from([0xef, 0xbb, 0xbf])), []);
});

test('a file with only whitespace gives no warning', (t) => {
  assert.deepEqual(warningsFor(t, '\r\n  \r\n'), []);
});
