'use strict';

// An event that cannot be read is refused, not passed through: exit code 2
// with the reason on stderr, and Cursor also gets its deny answer. The
// documented whenUnavailable "allow" setting lets such events pass.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNNER = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');

// Every directory a test makes is removed when the tests of this file are done.
const created = [];
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

function tmpHome(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-failclosed-'));
  created.push(home);
  if (config) {
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    fs.writeFileSync(path.join(home, '.zn', 'config.json'), JSON.stringify(config));
  }
  return home;
}

function hook(agent, input, home) {
  return spawnSync(process.execPath, [RUNNER, agent], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ZN_HOOK_FAIL_MODE: '' },
  });
}

test('an empty event is refused with exit code 2 and the reason on stderr', () => {
  const res = hook('codex', '', tmpHome());
  assert.equal(res.status, 2);
  assert.match(res.stderr, /stdin was empty/);
  assert.match(res.stderr, /was blocked/);
  assert.equal(res.stdout, '');
});

test('an event that is not JSON is refused with exit code 2 (Claude Code)', () => {
  const res = hook('claude-code', '{"hook_event_name": "PreToolUse", "tool_name":', tmpHome());
  assert.equal(res.status, 2);
  assert.match(res.stderr, /not valid JSON/);
});

test('Cursor gets its deny answer on stdout as well', () => {
  const res = hook('cursor', 'not json', tmpHome());
  assert.equal(res.status, 2);
  assert.match(res.stdout, /"permission":"deny"/);
  assert.match(res.stdout, /"continue":false/);
});

test('the model is never told how to let unchecked actions pass', () => {
  for (const agent of ['claude-code', 'codex', 'cursor']) {
    const res = hook(agent, 'not json', tmpHome());
    assert.equal(res.status, 2);
    assert.doesNotMatch(res.stderr, /whenUnavailable/, agent);
    assert.doesNotMatch(res.stdout, /whenUnavailable/, agent);
    assert.match(res.stderr, /hooks install/, agent);
  }
});

test('whenUnavailable "allow" passes such events, with a note on stderr', () => {
  const home = tmpHome({ hooks: { whenUnavailable: 'allow' } });
  const res = hook('codex', '', home);
  assert.equal(res.status, 0);
  assert.match(res.stderr, /passed through/);
  assert.equal(res.stdout, '');
});

test('valid JSON that is not an object is refused too', () => {
  for (const input of ['"text"', '42', '[1, 2]', 'null']) {
    const res = hook('claude-code', input, tmpHome());
    assert.equal(res.status, 2, input);
    assert.match(res.stderr, /not a JSON object/, input);
  }
});

test('an unexpected failure while handling the event is refused, not passed through', () => {
  // A non-string working directory makes the policy throw. The handler turns
  // that into a deny (fail-closed), so the call is refused.
  const ev = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat README.md' }, cwd: 5 };
  const res = hook('codex', JSON.stringify(ev), tmpHome());
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /"permissionDecision":"deny"/);
  assert.match(res.stdout, /something went wrong inside the zn hook/);
});

test('a readable event is still handled as before', () => {
  const ev = { session_id: 's', transcript_path: '/t', cwd: os.tmpdir(), hook_event_name: 'PreToolUse', model: 'm',
    tool_name: 'Bash', tool_input: { command: 'npm test' } };
  const res = hook('codex', JSON.stringify(ev), tmpHome());
  assert.equal(res.status, 0, res.stderr);
});
