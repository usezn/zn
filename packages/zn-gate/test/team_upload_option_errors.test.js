'use strict';
/*
 * Team audit upload: errors for bad options. Each bad call throws a TypeError
 * with a fixed text, sends nothing and creates no state or lock file.
 * The API is an in-memory fake; files live in temporary directories.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const audit = require('../lib/vault/audit');
const { uploadPending } = require('../lib/team/upload');

const INSTALL = '6f1c2b1e-0000-4000-8000-000000000003';
const KEY = Buffer.alloc(32, 9);

function setup(t) {
  const dir = tempDir(t, 'zn-team-upopts-');
  const f = {
    dir,
    auditFile: path.join(dir, 'audit.jsonl'),
    stateFile: path.join(dir, 'state', 'team-upload.json'),
    lockFile: path.join(dir, 'lock', 'team-upload.lock'),
  };
  for (let i = 0; i < 2; i++) {
    audit.append({
      decision: 'allow', secret: 'API_KEY_' + i, mode: 'env',
      agent: 'claude-code', tool: 'Bash', host: 'api.example.com', reason: 'policy',
    }, { file: f.auditFile, key: KEY });
  }
  return f;
}

function fakeApi() {
  const calls = [];
  return { calls, async ingest(body) { calls.push(body); return { status: 200, body: { accepted: body.events.length } }; } };
}

function opts(f, api, extra) {
  return Object.assign({
    auditFile: f.auditFile, stateFile: f.stateFile, lockFile: f.lockFile,
    installId: INSTALL, api,
  }, extra);
}

function assertUntouched(f, api) {
  assert.strictEqual(api.calls.length, 0);
  assert.strictEqual(fs.existsSync(f.stateFile), false);
  assert.strictEqual(fs.existsSync(f.lockFile), false);
  assert.strictEqual(fs.existsSync(path.dirname(f.lockFile)), false);
}

test('options that are not an object are refused', async (t) => {
  for (const bad of [undefined, null, 0, '', 'options', 42, true, false]) {
    await assert.rejects(uploadPending(bad), (err) => {
      assert.ok(err instanceof TypeError);
      assert.strictEqual(err.message, 'uploadPending: options object required');
      return true;
    });
  }
});

test('each required string field must be a non-empty string', async (t) => {
  const f = setup(t);
  for (const key of ['auditFile', 'stateFile', 'lockFile', 'installId']) {
    for (const bad of [undefined, null, '', 5, {}, ['x']]) {
      const api = fakeApi();
      await assert.rejects(uploadPending(opts(f, api, { [key]: bad })), (err) => {
        assert.ok(err instanceof TypeError);
        assert.strictEqual(err.message, `uploadPending: ${key} must be a non-empty string`);
        return true;
      });
      assertUntouched(f, api);
    }
  }
});

test('a missing or wrong api.ingest is refused', async (t) => {
  const f = setup(t);
  for (const bad of [undefined, null, {}, 'api', { ingest: 'nope' }, { ingest: null }, { ingest: {} }]) {
    await assert.rejects(uploadPending(opts(f, bad)), (err) => {
      assert.ok(err instanceof TypeError);
      assert.strictEqual(err.message, 'uploadPending: api.ingest must be a function');
      return true;
    });
    assert.strictEqual(fs.existsSync(f.stateFile), false);
    assert.strictEqual(fs.existsSync(f.lockFile), false);
  }
});

test('batchSize must be an integer from 1 to 500', async (t) => {
  const f = setup(t);
  for (const bad of [0, -1, 501, 1.5, '10', null, NaN]) {
    const api = fakeApi();
    await assert.rejects(uploadPending(opts(f, api, { batchSize: bad })), (err) => {
      assert.ok(err instanceof TypeError);
      assert.strictEqual(err.message, 'uploadPending: batchSize must be an integer from 1 to 500');
      return true;
    });
    assertUntouched(f, api);
  }
});

test('maxBatches must be a positive integer', async (t) => {
  const f = setup(t);
  for (const bad of [0, -3, 2.5, '5', null, Infinity]) {
    const api = fakeApi();
    await assert.rejects(uploadPending(opts(f, api, { maxBatches: bad })), (err) => {
      assert.ok(err instanceof TypeError);
      assert.strictEqual(err.message, 'uploadPending: maxBatches must be a positive integer');
      return true;
    });
    assertUntouched(f, api);
  }
});

test('now must be a function', async (t) => {
  const f = setup(t);
  for (const bad of [null, 0, '2026-01-01', {}]) {
    const api = fakeApi();
    await assert.rejects(uploadPending(opts(f, api, { now: bad })), (err) => {
      assert.ok(err instanceof TypeError);
      assert.strictEqual(err.message, 'uploadPending: now must be a function');
      return true;
    });
    assertUntouched(f, api);
  }
});

test('the options are checked in a fixed order', async (t) => {
  const f = setup(t);
  const api = fakeApi();
  await assert.rejects(uploadPending({ api: {}, batchSize: 0 }), /auditFile must be a non-empty string/);
  await assert.rejects(uploadPending(opts(f, {}, { batchSize: 0 })), /api\.ingest must be a function/);
  await assert.rejects(uploadPending(opts(f, api, { batchSize: 0, maxBatches: 0 })), /batchSize must be/);
  await assert.rejects(uploadPending(opts(f, api, { maxBatches: 0, now: 1 })), /maxBatches must be/);
  assertUntouched(f, api);
});

test('valid options still upload after the refusals', async (t) => {
  const f = setup(t);
  const api = fakeApi();
  const r = await uploadPending(opts(f, api));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(api.calls.length, 1);
});
