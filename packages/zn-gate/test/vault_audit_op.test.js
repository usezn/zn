'use strict';
// Vault audit op: which event kinds a client may append, and the source
// marking of records (client-reported vs written by the daemon itself).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');
const { tempDir } = require('./helpers/tmp');
const audit = require('../lib/vault/audit');

const KEY = crypto.randomBytes(32).toString('hex');

test('checkClientEvent accepts the kinds the hooks write', () => {
  const ok = [
    { secret: 'API_KEY', mode: 'named', agent: 'claude-code', tool: 'Bash', decision: 'restore', reason: 'first-use' },
    { secret: 'API_KEY', mode: 'detected', tool: 'Write', decision: 'withhold', reason: 'unknown_token' },
    { secret: 'API_KEY', mode: 'env', tool: 'zn run', decision: 'allow', reason: 'allowCommands: psql' },
    { secret: 'API_KEY', mode: null, tool: 'mcp:secrets_request', decision: 'ask', reason: 'needs approval' },
    { secret: 'API_KEY', mode: 'file', argv0: null, host: null, tool: 'mcp:secrets_render_file', decision: 'warn', reason: 'x' },
  ];
  for (const ev of ok) assert.equal(audit.checkClientEvent(ev), null, JSON.stringify(ev));
});

test('checkClientEvent refuses forged kinds, unknown fields and oversized values', () => {
  const bad = [
    [{ secret: 'API_KEY', mode: 'named', tool: 'Bash', decision: 'allow', reason: 'forged' }, /not written for tool/],
    [{ secret: 'API_KEY', mode: 'named', tool: 'zn run', decision: 'restore', reason: 'forged' }, /not written for tool/],
    [{ secret: 'API_KEY', mode: 'env', tool: 'Bash', decision: 'restore', reason: 'forged' }, /audit mode/],
    [{ secret: 'API_KEY', mode: 'named', tool: 'Bash', decision: 'restore', source: 'daemon' }, /unknown audit field/],
    [{ secret: 'API_KEY', mode: 'named', tool: 'Bash', decision: 'restore', value: 'x' }, /unknown audit field/],
    [{ secret: 'API_KEY', mode: 'named', tool: 'Bash', decision: 'restore', reason: 'x'.repeat(257) }, /longer than 256/],
    [{ secret: 'API_KEY', mode: 'named', tool: 'Bash' }, /not written for tool/],
    [{ secret: 42, mode: 'named', tool: 'Bash', decision: 'restore' }, /must be a string/],
    [null, /must be an object/],
    [['x'], /must be an object/],
  ];
  for (const [ev, re] of bad) assert.match(audit.checkClientEvent(ev) || '', re, JSON.stringify(ev));
});

test('records carry their source: client for client events, daemon otherwise', (t) => {
  const file = path.join(tempDir(t, 'zn-audit-src-'), 'audit.jsonl');
  const a = audit.append({ secret: 'API_KEY', mode: 'named', tool: 'Bash', decision: 'restore' }, { file, key: KEY, source: 'client' });
  const b = audit.append({ mode: 'unlock', decision: 'allow', reason: 'ttl:60m' }, { file, key: KEY });
  assert.equal(a.source, 'client');
  assert.equal(b.source, 'daemon');
  assert.deepEqual(audit.verify({ file, key: KEY }), { ok: true, records: 2 });
  assert.deepEqual(audit.read({ file }).map((e) => e.source), ['client', 'daemon']);
});
