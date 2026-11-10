'use strict';

// `zn why <id>` and `zn why` on records written with real rule ids: a read of a sensitive
// file (path:sensitive_file, from SENSITIVE_PATH_RULES) and a secret (hook-pre_tool-secret).
// Only the cases not covered by why.test.js: the sensitive-file block by id, the secret
// block by id with its command, and the last-block lookup after a sensitive-file block.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const rules = require('../lib/rules');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
// Documentation example key, not a real credential.
const FAKE_AWS = 'AKIAIOSFODNN7EXAMPLE';

test('the real rule list has the sensitive-file rule these tests use', () => {
  assert.ok(rules.SENSITIVE_PATH_RULES.some((r) => r.id === 'path:sensitive_file'));
});

let seq = 0;
function record(over) {
  seq++;
  return Object.assign({
    id: 'ev_fake_' + String(seq).padStart(8, '0'), timestamp: '2026-01-01T00:00:00.000Z',
    agent_environment: 'claude-code', phase: 'hook-pre_tool', tool_name: 'Bash',
    payload_sha256: '0'.repeat(64), payload_preview: '', verdict: 'block', rule: 'unknown', reason: '',
    engine: 'zn-hook', prev_hash: '0'.repeat(64), record_hash: '1'.repeat(64),
  }, over);
}

function setup(recs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-why-id-'));
  const file = path.join(home, '.zn', 'evidence.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return home;
}

function why(home, args) {
  return spawnSync(process.execPath, [CLI, 'why', ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', ZN_HOME: '', ZN_LOCAL_ONLY: 'true' },
  });
}

test('why <id> explains a read of a sensitive file, with no bypass command, and not the later block', () => {
  const envRead = record({ rule: 'path:sensitive_file', payload_preview: 'cat .env', reason: 'Targeting sensitive system credentials or environment file' });
  const later = record({ rule: 'hook-pre_tool-secret', payload_preview: 'echo ' + FAKE_AWS });
  const home = setup([envRead, later]);
  const r = why(home, [envRead.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('Record:  ' + envRead.id));
  assert.match(r.stdout, /path:sensitive_file - Text that points at a file that usually holds passwords or keys/);
  assert.match(r.stdout, /Preview: cat \.env/);
  assert.match(r.stdout, /No command lets this through\./);
  assert.match(r.stdout, /Who decides: You decide whether to keep using the source of the text\./);
  assert.doesNotMatch(r.stdout, /To go on, run this/);
  assert.doesNotMatch(r.stdout, /A secret value/, 'the later block must not be explained');
});

test('with no id, the last block after an allow is the sensitive-file read', () => {
  const envRead = record({ rule: 'path:sensitive_file', payload_preview: 'cat .env' });
  const allow = record({ verdict: 'allow', rule: '', payload_preview: 'ls' });
  const home = setup([envRead, allow]);
  const r = why(home, []);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('Record:  ' + envRead.id));
  assert.match(r.stdout, /path:sensitive_file/);
});

test('why <id> on a secret block prints the secret set command and never the fake value', () => {
  const secret = record({
    rule: 'hook-pre_tool-secret', payload_preview: 'export AWS_ACCESS_KEY_ID=' + FAKE_AWS,
    reason: 'secret kinds: aws_access_key',
  });
  const other = record({ rule: 'path:sensitive_file', payload_preview: 'cat .env' });
  const home = setup([secret, other]);
  const r = why(home, [secret.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hook-pre_tool-secret - A secret value in what zn checked before the agent ran a tool/);
  assert.match(r.stdout, /To go on, run this in your own terminal \(not through your agent\):\n {2}\S.*secret set NAME\n/);
  assert.match(r.stdout, /Save the value there/);
  assert.ok(!r.stdout.includes(FAKE_AWS), 'fake key printed');
  assert.doesNotMatch(r.stdout, /cat \.env/, 'the other record must not be printed');
});
