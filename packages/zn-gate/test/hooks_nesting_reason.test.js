'use strict';

// A tool input nested deeper than zn looks is refused (fail closed) with a reason that says so, not with the reason for
// text that is not valid Unicode. Each hook runs as its own process in a temporary home. Fictitious values only.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { hasUnsafeText, nestedTooDeep, MAX_NESTING } = require('../lib/safe-text');
const { tempDir } = require('./helpers/tmp');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

function nested(levels) {
  let v = { command: 'ls' };
  for (let i = 0; i < levels; i++) v = { n: v };
  return v;
}

function hook(t, toolInput) {
  const home = tempDir(t, 'zn-nest-');
  const ev = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: toolInput, session_id: 's1', cwd: home };
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off' };
  for (const k of Object.keys(env)) if (k.startsWith('ZN_') && k !== 'ZN_STATS') delete env[k];
  const r = spawnSync(process.execPath, [CLI, 'hook', 'claude-code'], { input: JSON.stringify(ev), env, cwd: home, encoding: 'utf8', timeout: 60000 });
  const out = r.stdout ? JSON.parse(r.stdout) : {};
  return { code: r.status, out: out.hookSpecificOutput || {} };
}

test('nestedTooDeep follows the same limit as hasUnsafeText', () => {
  assert.equal(MAX_NESTING, 64);
  assert.equal(nestedTooDeep(nested(10)), false);
  assert.equal(nestedTooDeep(nested(200)), true);
  assert.equal(hasUnsafeText(nested(200)), true, 'a too deep value is still refused');
  assert.equal(nestedTooDeep([[[]]]), false);
  assert.equal(nestedTooDeep('text'), false);
});

test('a tool input nested 200 levels is denied with the nesting reason', (t) => {
  const r = hook(t, nested(200));
  assert.equal(r.code, 0);
  assert.equal(r.out.permissionDecision, 'deny');
  assert.match(r.out.permissionDecisionReason, /nested more than 64 levels deep/);
  assert.doesNotMatch(r.out.permissionDecisionReason, /Unicode/);
});

test('text that is not valid Unicode keeps its own reason', (t) => {
  const r = hook(t, { command: 'cat a' + String.fromCharCode(0xD800) + 'b' });
  assert.equal(r.out.permissionDecision, 'deny');
  assert.match(r.out.permissionDecisionReason, /not valid Unicode/);
});
