'use strict';
/* uploadPending rejects invalid options before it touches any file. */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { uploadPending } = require('../lib/team/upload');

function validOptions(dir) {
  return {
    auditFile: path.join(dir, 'audit.log'),
    stateFile: path.join(dir, 'state.json'),
    lockFile: path.join(dir, 'upload.lock'),
    installId: '6f1c2b1e-0000-4000-8000-000000000001',
    api: { ingest: async () => ({ ok: true }) },
  };
}

test('uploadPending rejects a missing options object', async () => {
  await assert.rejects(() => uploadPending(undefined), (err) => {
    assert.ok(err instanceof TypeError);
    assert.strictEqual(err.message, 'uploadPending: options object required');
    return true;
  });
});

test('uploadPending rejects an empty installId', async (t) => {
  const opts = { ...validOptions(tempDir(t, 'zn-upload-err-')), installId: '' };
  await assert.rejects(() => uploadPending(opts), (err) => {
    assert.ok(err instanceof TypeError);
    assert.strictEqual(err.message, 'uploadPending: installId must be a non-empty string');
    return true;
  });
});

test('uploadPending rejects a batchSize above the maximum', async (t) => {
  const opts = { ...validOptions(tempDir(t, 'zn-upload-err-')), batchSize: 501 };
  await assert.rejects(() => uploadPending(opts), (err) => {
    assert.ok(err instanceof TypeError);
    assert.strictEqual(err.message, 'uploadPending: batchSize must be an integer from 1 to 500');
    return true;
  });
});
