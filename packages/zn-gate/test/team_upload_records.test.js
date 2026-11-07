'use strict';
/*
 * Team upload: how ledger lines are read, filtered and turned into events.
 * The record helpers are not exported, so they are checked through
 * pendingCount (count of pending records) and uploadPending (event shape).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { uploadPending, pendingCount } = require('../lib/team/upload');

const INSTALL = '6f1c2b1e-0000-4000-8000-000000000002';
const HEX = (c) => c.repeat(64);

function setup(t) {
  const dir = tempDir(t, 'zn-team-rec-');
  return {
    auditFile: path.join(dir, 'audit.jsonl'),
    stateFile: path.join(dir, 'team-upload.json'),
    lockFile: path.join(dir, 'team-upload.lock'),
  };
}

function line(seq, extra) {
  return JSON.stringify(Object.assign({ v: 1, seq, ts: '2026-01-01T00:00:00.000Z', prev: HEX('0'), mac: HEX('a') }, extra));
}

function capture() {
  const bodies = [];
  return {
    bodies,
    api: {
      ingest: async (body) => {
        bodies.push(body);
        const last = body.events[body.events.length - 1];
        return { status: 200, body: { accepted: body.events.length, head: { seq: last.seq, mac: last.mac } } };
      },
    },
  };
}

function run(f, api) {
  return uploadPending({
    auditFile: f.auditFile, stateFile: f.stateFile, lockFile: f.lockFile, installId: INSTALL, api,
  });
}

test('an empty ledger file has nothing pending and nothing to upload', async (t) => {
  const f = setup(t);
  fs.writeFileSync(f.auditFile, '');
  assert.strictEqual(pendingCount({ auditFile: f.auditFile, stateFile: f.stateFile }), 0);
  const cap = capture();
  const res = await run(f, cap.api);
  assert.strictEqual(res.status, 'nothing');
  assert.strictEqual(res.pending, 0);
  assert.strictEqual(cap.bodies.length, 0);
});

test('a missing ledger file has nothing pending', (t) => {
  const f = setup(t);
  assert.strictEqual(pendingCount({ auditFile: f.auditFile, stateFile: f.stateFile }), 0);
});

test('a half-written last line is skipped and the complete records are counted', async (t) => {
  const f = setup(t);
  const half = line(3).slice(0, 25);
  fs.writeFileSync(f.auditFile, [line(1), line(2), half].join('\n'));
  assert.strictEqual(pendingCount({ auditFile: f.auditFile, stateFile: f.stateFile }), 2);
  const cap = capture();
  const res = await run(f, cap.api);
  assert.strictEqual(res.status, 'ok');
  assert.deepStrictEqual(cap.bodies[0].events.map((e) => e.seq), [1, 2]);
  assert.strictEqual(res.head.seq, 2);
  assert.strictEqual(res.pending, 0);
});

test('a record without a hash is not a record and is never sent', async (t) => {
  const f = setup(t);
  const noMac = JSON.parse(line(2));
  delete noMac.mac;
  fs.writeFileSync(f.auditFile, [line(1), JSON.stringify(noMac), line(3)].join('\n') + '\n');
  assert.strictEqual(pendingCount({ auditFile: f.auditFile, stateFile: f.stateFile }), 2);
  const cap = capture();
  const res = await run(f, cap.api);
  // The skipped record leaves a hole in the sequence, so only the records before it go out.
  assert.strictEqual(res.status, 'local_gap');
  assert.deepStrictEqual(cap.bodies[0].events.map((e) => e.seq), [1]);
});

test('lines that are not records are skipped', (t) => {
  const f = setup(t);
  const bad = [
    '[]', 'null', '"text"', '42',
    JSON.stringify({ seq: 0, prev: 'p', mac: 'm' }),
    JSON.stringify({ seq: 1.5, prev: 'p', mac: 'm' }),
    JSON.stringify({ seq: '2', prev: 'p', mac: 'm' }),
    JSON.stringify({ seq: 2, mac: 'm' }),
    JSON.stringify({ seq: 2, prev: 'p', mac: 7 }),
  ];
  fs.writeFileSync(f.auditFile, bad.concat([line(1)]).join('\n') + '\n');
  assert.strictEqual(pendingCount({ auditFile: f.auditFile, stateFile: f.stateFile }), 1);
});

test('a record with every field is sent with those fields in chain order', async (t) => {
  const f = setup(t);
  const full = {
    v: 1, seq: 1, ts: '2026-01-01T00:00:00.000Z',
    reason: 'policy', decision: 'allow', host: 'api.example.com', argv0: 'curl', tool: 'Bash',
    agent: 'claude-code', mode: 'env', secret: 'API_KEY_ONE',
    prev: HEX('0'), mac: HEX('b'),
  };
  fs.writeFileSync(f.auditFile, JSON.stringify(full) + '\n');
  const cap = capture();
  const res = await run(f, cap.api);
  assert.strictEqual(res.status, 'ok');
  const ev = cap.bodies[0].events[0];
  assert.deepStrictEqual(Object.keys(ev), [
    'v', 'seq', 'ts', 'secret', 'mode', 'agent', 'tool', 'argv0', 'host', 'decision', 'reason', 'prev', 'mac',
  ]);
  assert.deepStrictEqual(ev, Object.assign({}, full));
});

test('fields outside the allowed set are dropped from the event', async (t) => {
  const f = setup(t);
  fs.writeFileSync(f.auditFile, line(1, { secret: 'API_KEY_ONE', note: 'local only', extra: { a: 1 } }) + '\n');
  const cap = capture();
  await run(f, cap.api);
  const ev = cap.bodies[0].events[0];
  assert.strictEqual(ev.secret, 'API_KEY_ONE');
  assert.strictEqual('note' in ev, false);
  assert.strictEqual('extra' in ev, false);
});

test('pending counts only records after the stored head', (t) => {
  const f = setup(t);
  fs.writeFileSync(f.auditFile, [line(1), line(2), line(3)].join('\n') + '\n');
  fs.writeFileSync(f.stateFile, JSON.stringify({ head: { seq: 2, mac: HEX('a') }, last_upload: null, last_status: 'ok' }));
  assert.strictEqual(pendingCount({ auditFile: f.auditFile, stateFile: f.stateFile }), 1);
  fs.writeFileSync(f.stateFile, JSON.stringify({ head: { seq: 3, mac: HEX('a') }, last_upload: null, last_status: 'ok' }));
  assert.strictEqual(pendingCount({ auditFile: f.auditFile, stateFile: f.stateFile }), 0);
});
