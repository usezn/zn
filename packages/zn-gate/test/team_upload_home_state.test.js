'use strict';
/*
 * Team upload: the state file lives under a temporary HOME. A missing, empty
 * or truncated file, and a file that only carries an unknown version number,
 * each start from a clean state: the next upload begins at record 1.
 * The API is an in-memory fake and all values are fictitious.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const audit = require('../lib/vault/audit');
const { uploadPending, pendingCount } = require('../lib/team/upload');

const INSTALL = '6f1c2b1e-0000-4000-8000-000000000003';
const KEY = Buffer.alloc(32, 9);

function setup(t) {
  const home = tempDir(t, 'zn-team-home-');
  const dir = path.join(home, '.zn');
  fs.mkdirSync(dir, { recursive: true });
  return {
    auditFile: path.join(dir, 'audit.jsonl'),
    stateFile: path.join(dir, 'team-upload.json'),
    lockFile: path.join(dir, 'team-upload.lock'),
  };
}

function fillLog(file, count) {
  for (let i = 0; i < count; i++) {
    audit.append({
      decision: 'allow', secret: 'API_KEY_' + i, mode: 'env',
      agent: 'claude-code', tool: 'Bash', host: 'api.example.com', reason: 'policy',
    }, { file, key: KEY });
  }
}

function fakeApi() {
  const api = { calls: [] };
  api.ingest = async (body) => {
    api.calls.push(JSON.parse(JSON.stringify(body)));
    return { status: 200, body: { accepted: body.events.length } };
  };
  return api;
}

function opts(f, api) {
  return { auditFile: f.auditFile, stateFile: f.stateFile, lockFile: f.lockFile, api, installId: INSTALL };
}

const CASES = [
  ['missing', null],
  ['empty', ''],
  ['truncated JSON', '{"head":{"seq":2,"mac":"ab'],
  ['unknown version number', JSON.stringify({ version: 99, last_status: 'ok' })],
];

for (const [name, content] of CASES) {
  test(`state file ${name}: starts from a clean state`, async (t) => {
    const f = setup(t);
    fillLog(f.auditFile, 4);
    if (content !== null) fs.writeFileSync(f.stateFile, content);
    else assert.strictEqual(fs.existsSync(f.stateFile), false);

    assert.strictEqual(pendingCount({ auditFile: f.auditFile, stateFile: f.stateFile }), 4);

    const api = fakeApi();
    const r = await uploadPending(opts(f, api));
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.uploaded, 4);
    assert.deepStrictEqual(api.calls[0].events.map((e) => e.seq), [1, 2, 3, 4]);

    const saved = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
    assert.strictEqual(saved.head.seq, 4);
    assert.strictEqual(saved.last_status, 'ok');
    assert.strictEqual('version' in saved, false);
  });
}
