'use strict';

process.env.ZN_STATS = 'off';

// The post-tool check has limits (characters, different secret values, a deadline before the agent's hook
// timeout, stdin size). When one is reached the output is not denied (a deny does not withhold it in Claude
// Code, Copilot or OpenCode) and not passed on: the hook replaces what it could not check with a fixed
// notice, for every agent that can take a replacement.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const fakeEngine = require('./helpers/fake_engine');
const { createFakeVault } = require('./helpers/fake_vault');
const { AGENTS } = require('./helpers/post_events');
const { budget } = require('./helpers/time_budget');

const NOTICE = /output withheld because it is too large to check/;
const LAST_KEY = 'AKIAQQQQQQQQQQQQQQQQ'; // fictitious
const key = (i) => 'AKIA' + i.toString(36).toUpperCase().padStart(16, 'A'); // fictitious, all different
const keys = (n) => Array.from({ length: n }, (_, i) => key(i));

function slowVault(ms) {
  const v = createFakeVault();
  const mapToken = v.mapToken.bind(v);
  v.mapToken = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return mapToken(...args);
  };
  return v;
}

function handle(name, raw, extra = {}) {
  return runner.handle(getAdapter(name), raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', ...extra });
}

for (const [name, a] of Object.entries(AGENTS)) {
  test(name + ': 5,000 different keys and one more at the end, slow vault: the last key never reaches the agent', async () => {
    const text = keys(5000).join('\n') + '\n' + LAST_KEY;
    const t = Date.now();
    const r = await handle(name, a.event(text), { vault: slowVault(5) });
    const ms = Date.now() - t;
    assert.ok(ms < budget(5000), 'answered in ' + ms + ' ms');
    assert.equal(r.decision.decision, 'allow');
    assert.ok(r.output, 'the hook answers');
    const everything = JSON.stringify(r.output);
    assert.ok(!everything.includes(LAST_KEY));
    assert.ok(!everything.includes(key(0)));
    assert.match(a.seen(r.output), NOTICE);
    assert.ok(everything.length < 5000, 'the answer is small: ' + everything.length);
    assert.ok(a.shapeKept(r.output));
  });

  test(name + ': the deadline passes while the vault is slow: the output is withheld, not passed on', async () => {
    const text = keys(30).join('\n') + '\n' + LAST_KEY;
    const t = Date.now();
    const r = await handle(name, a.event(text), { vault: slowVault(100), postDeadlineMs: 300 });
    const ms = Date.now() - t;
    assert.ok(ms < budget(2000), 'answered in ' + ms + ' ms');
    assert.equal(r.decision.decision, 'allow');
    assert.equal(r.decision.abandoned, true);
    const everything = JSON.stringify(r.output);
    assert.ok(!everything.includes(LAST_KEY));
    assert.match(a.seen(r.output), NOTICE);
  });

  test(name + ': an output over the character limit is withheld, a small one next to it is kept', async () => {
    const r = await handle(name, a.event('x'.repeat(500) + ' ' + LAST_KEY), { postScanCap: 100 });
    assert.equal(r.decision.decision, 'allow');
    assert.ok(!JSON.stringify(r.output).includes(LAST_KEY));
    assert.match(a.seen(r.output), NOTICE);
  });

  test(name + ': a normal output with a few keys is redacted as before', async () => {
    const r = await handle(name, a.event('a=' + key(1) + ' b=' + key(2)), { vault: slowVault(5) });
    assert.equal(r.decision.decision, 'allow');
    assert.ok(!r.decision.abandoned);
    const seen = a.seen(r.output);
    assert.ok(!seen.includes(key(1)) && !seen.includes(key(2)));
    assert.match(seen, /__ZN_AWS_KEY_1__/);
    assert.match(seen, /__ZN_AWS_KEY_2__/);
    assert.doesNotMatch(seen, NOTICE);
  });

  test(name + ': an event over the stdin limit is answered with the notice', async () => {
    const filler = 'A'.repeat(runner.POST_STDIN_CAP + 10);
    const head = JSON.stringify(a.event('FILLER')).replace('FILLER', () => filler);
    const out = [];
    const write = process.stdout.write;
    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    try {
      await runner.main([name], async () => head);
    } finally {
      process.stdout.write = write;
    }
    assert.equal(out.length, 1);
    assert.match(out[0], NOTICE);
    assert.ok(out[0].length < 2000);
    assert.ok(!out[0].includes('AAAA'));
  });
}

test('an event over the stdin limit that is not a post-tool event is refused', async () => {
  const filler = 'A'.repeat(runner.POST_STDIN_CAP + 10);
  const pre = { session_id: 's', cwd: '/', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: filler } };
  const err = [];
  const write = process.stderr.write;
  const code = process.exitCode;
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    await runner.main(['claude-code'], async () => JSON.stringify(pre));
    assert.equal(process.exitCode, 2);
  } finally {
    process.stderr.write = write;
    process.exitCode = code;
  }
  assert.match(err.join(''), /too large/);
});

for (const [name, pre, nested] of [
  ['claude-code', { session_id: 's', cwd: '/', hook_event_name: 'PreToolUse', tool_name: 'mcp__srv__tool', tool_input: { hook_event_name: 'PostToolUse', data: '' } }, 'PostToolUse'],
  ['codex', { session_id: 's', cwd: '/', hook_event_name: 'PreToolUse', tool_name: 'mcp__srv__tool', tool_input: { hook_event_name: 'PostToolUse', data: '' } }, 'PostToolUse'],
  ['cursor', { hook_event_name: 'preToolUse', cwd: '/', tool_name: 'MCP:tool', tool_input: { hook_event_name: 'postToolUse', data: '' } }, 'postToolUse'],
]) {
  test(name + ': an oversized pre-tool event with the post-tool event name inside its arguments is refused, not answered', async () => {
    pre.tool_input.data = 'A'.repeat(runner.POST_STDIN_CAP + 10);
    const err = [];
    const out = [];
    const write = process.stderr.write;
    const wout = process.stdout.write;
    const code = process.exitCode;
    process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    try {
      await runner.main([name], async () => JSON.stringify(pre));
      assert.equal(process.exitCode, 2);
    } finally {
      process.stderr.write = write;
      process.stdout.write = wout;
      process.exitCode = code;
    }
    assert.match(err.join(''), /too large/);
    assert.ok(!out.join('').includes('withheld'));
    assert.ok(!out.join('').includes(nested) || out.join('').includes('deny'));
  });
}

for (const [name, pre] of [
  ['opencode', { hook: 'tool.execute.before', tool: 'bash', cwd: '/', args: { hook: 'tool.execute.after', data: '' } }],
  ['copilot', { sessionId: 's', timestamp: 1792400000000, cwd: '/', toolName: 'bash', toolArgs: { toolResult: 1, data: '' } }],
  ['copilot', { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/', tool_name: 'bash', tool_input: { tool_result: 1, data: '' } }],
]) {
  test(name + ': an oversized pre-tool event with a post-tool marker inside its arguments is refused (' + Object.keys(pre)[0] + ')', async () => {
    const arg = pre.args || pre.toolArgs || pre.tool_input;
    arg.data = 'A'.repeat(runner.POST_STDIN_CAP + 10);
    const err = [];
    const out = [];
    const write = process.stderr.write;
    const wout = process.stdout.write;
    const code = process.exitCode;
    process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    try {
      await runner.main([name], async () => JSON.stringify(pre));
      assert.equal(process.exitCode, 2);
    } finally {
      process.stderr.write = write;
      process.stdout.write = wout;
      process.exitCode = code;
    }
    assert.match(err.join(''), /too large/);
    assert.ok(!out.join('').includes('withheld'));
  });
}

for (const name of ['opencode', 'copilot']) {
  test(name + ': an oversized post-tool event is still answered with the notice', async () => {
    const big = AGENTS[name].event('A'.repeat(runner.POST_STDIN_CAP + 10));
    const out = [];
    const wout = process.stdout.write;
    const code = process.exitCode;
    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    try {
      await runner.main([name], async () => JSON.stringify(big));
    } finally {
      process.stdout.write = wout;
      process.exitCode = code;
    }
    assert.match(out.join(''), NOTICE);
  });
}

test('the deadline is the agent hook timeout minus five seconds, from each adapter', () => {
  const seconds = { 'claude-code': 15, codex: 30, copilot: 15, cursor: 30, opencode: 20, antigravity: 15 };
  for (const [name, s] of Object.entries(seconds)) {
    assert.equal(getAdapter(name).HOOK_TIMEOUT_S, s, name);
    assert.equal(runner.postDeadlineMs(name), (s - 5) * 1000, name);
  }
  assert.equal(getAdapter('gemini').HOOK_TIMEOUT_MS, 15000);
  assert.equal(runner.postDeadlineMs('gemini'), 10000);
  assert.equal(runner.postDeadlineMs('unknown-agent'), 10000);
  assert.match(getAdapter('opencode').pluginSource({}), /const TIMEOUT_MS = 20000;/);
});

test('the real engine: 5,000 different keys and one more at the end: the last key never reaches Claude Code', async () => {
  const engine = require('../lib/scrub/engine');
  const raw = AGENTS['claude-code'].event(keys(5000).join('\n') + '\n' + LAST_KEY);
  const r = await runner.handle(getAdapter('claude-code'), raw, { engine, vault: slowVault(5), failMode: 'open' });
  assert.ok(!JSON.stringify(r.output).includes(LAST_KEY));
  assert.match(r.output.hookSpecificOutput.updatedToolOutput.stdout, NOTICE);
});
