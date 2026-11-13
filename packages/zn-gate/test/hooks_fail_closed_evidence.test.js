'use strict';

// A block the hook makes because it could not check an action leaves one evidence record, under its own rule and with
// no content from the event, so `zn why` and the log show it. Each hook runs as its own process in a temporary home.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { tempDir } = require('./helpers/tmp');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

function run(t, toolInput) {
  const home = tempDir(t, 'zn-fcev-');
  const ev = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: toolInput, session_id: 's1', cwd: home };
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off' };
  for (const k of Object.keys(env)) if (k.startsWith('ZN_') && k !== 'ZN_STATS') delete env[k];
  const r = spawnSync(process.execPath, [CLI, 'hook', 'claude-code'], { input: JSON.stringify(ev), env, cwd: home, encoding: 'utf8', timeout: 60000 });
  const file = path.join(home, '.zn', 'evidence.jsonl');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { out: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput || {} : {}, records: lines.map((l) => JSON.parse(l)) };
}

function nested(levels) {
  let v = { command: 'ls' };
  for (let i = 0; i < levels; i++) v = { n: v };
  return v;
}

test('a block because the input could not be checked writes one record with its own rule', (t) => {
  const r = run(t, nested(200));
  assert.equal(r.out.permissionDecision, 'deny');
  assert.equal(r.records.length, 1, JSON.stringify(r.records));
  const rec = r.records[0];
  assert.equal(rec.verdict, 'block');
  assert.equal(rec.rule, 'hook-fail-closed');
  assert.match(rec.reason, /^zn could not check this action \(ZN_[A-Z_]+\), so it was blocked$/);
  assert.ok(!JSON.stringify(rec).includes('"n"'), 'no content from the event is stored');
});

test('a policy block keeps its usual record and an allowed call writes none', (t) => {
  const allowed = run(t, { command: 'ls -la' });
  assert.equal(allowed.records.length, 0);
  const home = tempDir(t, 'zn-fcev-');
  fs.writeFileSync(path.join(home, '.env'), 'API_TOKEN=fake-value-0000\n');
  const ev = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(home, '.env') }, session_id: 's1', cwd: home };
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off' };
  for (const k of Object.keys(env)) if (k.startsWith('ZN_') && k !== 'ZN_STATS') delete env[k];
  spawnSync(process.execPath, [CLI, 'hook', 'claude-code'], { input: JSON.stringify(ev), env, cwd: home, encoding: 'utf8', timeout: 60000 });
  const recs = fs.readFileSync(path.join(home, '.zn', 'evidence.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(recs.length, 1);
  assert.notEqual(recs[0].rule, 'hook-fail-closed');
});
