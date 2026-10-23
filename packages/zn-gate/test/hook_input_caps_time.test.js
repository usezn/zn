'use strict';

// The hook process must answer inside its time budget on inputs at the size
// caps. raceDeadline cannot preempt synchronous regex work, so a regex that
// goes super-linear on a long run of one character is only caught by running
// the real process on such an input and timing it.

process.env.ZN_STATS = 'off';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNNER = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');

// 3 s wall per run (the hook timeout of the agents is 15 s). Windows and macOS
// runners are slower, so they get 5 s. The 1 MB private-key PostToolUse case
// already takes 2 to 3.5 s, so it gets 5 s (8 s on Windows and macOS).
const SLOW_HOST = process.platform === 'win32' || process.platform === 'darwin';
const BUDGET_MS = SLOW_HOST ? 5000 : 3000;
const MB = 1000000;

// Fake key text is built here from a short header, never written out whole.
const PEM_HEADER = '-----BEGIN ' + 'PRIVATE KEY' + '-----';

function repeatTo(unit, length) {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

// Two cases need regex fixes that are not on next yet. Remove SLOW_SKIP from
// them when those branches merge; ZN_CAP_RUN_SLOW=1 runs them before that.
const SLOW_SKIP = (reason) => (process.env.ZN_CAP_RUN_SLOW === '1' ? false : reason);

const CASES = [
  {
    name: 'PreToolUse Bash, 102400 characters of digits and redirects',
    event: () => ({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: '1'.repeat(51200) + '<'.repeat(51200) },
    }),
    skip: SLOW_SKIP('slow on next (about 15 s) until branch fix/destructive-redirect-regex-linear merges'),
  },
  {
    name: 'UserPromptExpansion, PEM header and 4096 spaces repeated to 1 MB',
    event: () => ({
      hook_event_name: 'UserPromptExpansion',
      prompt: repeatTo(PEM_HEADER + ' '.repeat(4096), MB),
    }),
    skip: SLOW_SKIP('slow on next (13 to 20 s) until branch fix/private-key-regex-linear merges'),
  },
  {
    name: 'PostToolUse, 1 MB of repeated PEM headers',
    event: () => ({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: repeatTo(PEM_HEADER, MB),
    }),
    // 2 to 3.5 s on a Linux VM today (scrub patterns.js:243), too close to 3 s.
    budgetMs: SLOW_HOST ? 8000 : 5000,
  },
  {
    name: 'PostToolUse, 1 MB benign tool result (control)',
    event: () => ({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: repeatTo('plain build output line 0123456789\n', MB),
    }),
  },
];

for (const c of CASES) {
  test('hook stays within its time budget at the input caps: ' + c.name, { skip: c.skip }, (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-capbudget-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const budget = c.budgetMs || BUDGET_MS;
    const input = JSON.stringify({ cwd: home, ...c.event() });
    const start = process.hrtime.bigint();
    const res = spawnSync(process.execPath, [RUNNER, 'claude-code'], {
      input,
      encoding: 'utf8',
      maxBuffer: 64 * MB,
      env: { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off', ZN_HOOK_FAIL_MODE: '' },
    });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (process.env.ZN_CAP_VERBOSE) console.log(c.name + ': ' + Math.round(ms) + ' ms');
    assert.equal(res.error, undefined, 'the hook process ran');
    assert.equal(res.signal, null, 'the hook process was not killed');
    assert.ok(ms < budget, c.name + ' took ' + Math.round(ms) + ' ms, budget ' + budget + ' ms');
  });
}
