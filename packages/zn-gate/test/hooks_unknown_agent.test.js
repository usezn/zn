'use strict';
process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: '', env: { ...process.env, ZN_STATS: 'off' } });
}

for (const action of ['install', 'uninstall']) {
  for (const name of ['copilot']) {
    test('hooks ' + action + ' ' + name + ' says it is not available yet, before any terminal check', () => {
      const r = run(['hooks', action, name]);
      assert.equal(r.status, 64);
      assert.match(r.stderr, /not available for GitHub Copilot CLI yet\. Supported agents: claude-code, codex, cursor, opencode, antigravity, gemini\./);
      assert.doesNotMatch(r.stderr, /interactive terminal/);
    });
  }
}

test('hooks install with a misspelled agent suggests the closest one', () => {
  const r = run(['hooks', 'install', 'claud-code']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /unknown agent "claud-code"\. Did you mean "claude-code"\?/);
  assert.doesNotMatch(r.stderr, /interactive terminal/);
});

test('hooks install with a nonsense agent lists the supported ones', () => {
  const r = run(['hooks', 'install', 'zzzzzzzz']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /unknown agent "zzzzzzzz"\. Supported agents:/);
});

for (const name of ['gemini', 'gemini-cli']) {
  test('hooks install ' + name + ' is a supported agent: without a terminal it keeps the interactive-terminal refusal', () => {
    const r = run(['hooks', 'install', name]);
    assert.notEqual(r.status, 0);
    assert.notEqual(r.status, 64);
    assert.match(r.stderr, /needs an interactive terminal/);
    assert.doesNotMatch(r.stderr, /not available/);
  });
}

test('a supported agent without a terminal keeps the interactive-terminal refusal', () => {
  const r = run(['hooks', 'install', 'cursor']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /needs an interactive terminal/);
  assert.doesNotMatch(r.stderr, /unknown agent|not available for/);
});
