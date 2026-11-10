'use strict';

// lib/agents/launcher.js: the error texts for a bad agent id, a bad runner
// digest and unsafe text in the project hook are thrown for the right input and
// for no other. Values are fake; files live in temporary directories.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const launcher = require('../lib/agents/launcher');

function tempRunner(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-launcher-texts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runner = path.join(dir, 'runner.js');
  fs.writeFileSync(runner, '// fake runner\n');
  return runner;
}

const BAD_IDS = ['', 'Codex', 'codex1', 'co dex', 'codex\n', '../codex', 'codex;x', 'codex_x'];

test('a bad agent id is refused with its text by every entry point that takes one', (t) => {
  const runner = tempRunner(t);
  for (const id of BAD_IDS) {
    const msg = 'zn: bad agent id ' + id;
    assert.throws(() => launcher.unixScript(id, process.execPath, runner, { runnerDigest: 'ab'.repeat(32) }), { message: msg }, JSON.stringify(id));
    assert.throws(() => launcher.projectShCommand(id, 'PreToolUse'), { message: msg }, JSON.stringify(id));
    assert.throws(() => launcher.projectWindowsScript(id, 'PreToolUse'), { message: msg }, JSON.stringify(id));
  }
});

test('a lower-case agent id with dashes is not refused as a bad agent id', (t) => {
  const runner = tempRunner(t);
  for (const id of ['codex', 'claude-code', 'a', 'x-y-z']) {
    assert.doesNotThrow(() => launcher.unixScript(id, process.execPath, runner, { runnerDigest: 'ab'.repeat(32) }), id);
  }
});

test('a bad runner digest is refused with its text', (t) => {
  const runner = tempRunner(t);
  for (const digest of ['not hex', 'ABCDEF', 'ab\n', "ab'cd", 'xyz', 12, null, {}, ['ab']]) {
    assert.throws(() => launcher.unixScript('codex', process.execPath, runner, { runnerDigest: digest }), { message: 'zn: bad runner digest' }, JSON.stringify(digest));
  }
});

test('a lower-case hex digest is accepted when the launcher is written; an empty one (unreadable runner file, see runnerSha) is written too, and the launcher then refuses to run the runner (see hooks_launcher_integrity.test.js)', (t) => {
  const runner = tempRunner(t);
  for (const digest of ['', '0', 'ab'.repeat(32), '0123456789abcdef']) {
    assert.doesNotThrow(() => launcher.unixScript('codex', process.execPath, runner, { runnerDigest: digest }), digest);
  }
});

test('the digest of the runner file itself is accepted when none is given', (t) => {
  const runner = tempRunner(t);
  const text = launcher.unixScript('codex', process.execPath, runner);
  assert.match(text, new RegExp("^ZN_SHA='" + launcher.runnerSha(runner) + "'$", 'm'));
});

test('the bad agent id check comes before the digest check', (t) => {
  const runner = tempRunner(t);
  assert.throws(() => launcher.unixScript('Bad', process.execPath, runner, { runnerDigest: 'zz' }), { message: 'zn: bad agent id Bad' });
});

test('the project hook texts are safe for every agent, so the unsafe text error is never thrown', () => {
  for (const id of ['antigravity', 'copilot', 'cursor', 'gemini', 'codex', 'claude-code']) {
    assert.doesNotThrow(() => launcher.projectShCommand(id, 'PreToolUse'), id);
    assert.doesNotThrow(() => launcher.projectWindowsScript(id, 'PreToolUse'), id);
  }
});
