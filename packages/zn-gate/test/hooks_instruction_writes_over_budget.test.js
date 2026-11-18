'use strict';

// A command that names more files than the instruction-file check reads (64) is not allowed silently: it gets the
// decision of a write to an instruction file (ask; deny in strict mode). Fictitious file names only.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runner = require('../lib/hooks/runner');
const { getAdapter } = require('../lib/agents');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const claude = getAdapter('claude-code');

function setup(t, config) {
  const home = tempDir(t, 'zn-instr-over-');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  if (config !== undefined) {
    fs.mkdirSync(path.join(home, '.zn'));
    fs.writeFileSync(path.join(home, '.zn', 'config.json'), JSON.stringify(config));
  }
  return { home, proj };
}

async function decide(env, command) {
  const raw = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: env.proj, session_id: 's' };
  const res = await runner.handle(claude, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'zn run --', home: env.home });
  const o = res.output && res.output.hookSpecificOutput;
  return { decision: o ? o.permissionDecision : 'allow', reason: o ? o.permissionDecisionReason : '' };
}

const names = (n) => Array.from({ length: n }, (_, i) => 'a' + i).join(' ');

test('touch of 70 files plus a redirect into AGENTS.md asks (was a silent allow)', async (t) => {
  const env = setup(t);
  const r = await decide(env, 'touch ' + names(70) + '; echo hi >> AGENTS.md');
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /too many files to check/);
});

test('touch of 70 files plus a redirect into AGENTS.md is refused in strict mode', async (t) => {
  const env = setup(t, { hooks: { strict: true } });
  const r = await decide(env, 'touch ' + names(70) + '; echo hi >> AGENTS.md');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /too many files to check/);
  const d = await decide(setup(t, { hooks: { agentInstructionWrites: 'deny' } }), 'touch ' + names(70) + '; echo hi >> AGENTS.md');
  assert.equal(d.decision, 'deny');
});

test('the check stays off when agentInstructionWrites is off, even with 70 targets', async (t) => {
  const env = setup(t, { hooks: { agentInstructionWrites: 'off' } });
  assert.equal((await decide(env, 'touch ' + names(70) + '; echo hi >> AGENTS.md')).decision, 'allow');
});

test('fail closed: a benign touch of 70 files, none an instruction file, also asks (it cannot all be checked)', async (t) => {
  const env = setup(t);
  assert.equal((await decide(env, 'touch ' + names(70))).decision, 'ask');
});

test('at the limit (64 targets) a benign command is still allowed, and an instruction file among them asks by name', async (t) => {
  const env = setup(t);
  assert.equal((await decide(env, 'touch ' + names(64))).decision, 'allow');
  const r = await decide(env, 'touch ' + names(10) + ' AGENTS.md');
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /AGENTS\.md/);
});

test('a command that only reads many files (not a writer) is still allowed', async (t) => {
  const env = setup(t);
  assert.equal((await decide(env, 'cat ' + names(100))).decision, 'allow');
});

// python -c code that opens N files for writing: the scanner collects at most one more than the budget, so a capped
// scan cannot read as an exact fit.
const pyOpens = (n, last) => 'python3 -c "' + Array.from({ length: n }, (_, i) => "open('b" + i + "','w')").concat(last ? ["open('" + last + "','w')"] : []).join(';') + '"';

test('python -c: 64 benign write targets are allowed; a protected 65th target asks (deny in strict)', async (t) => {
  const env = setup(t);
  assert.equal((await decide(env, pyOpens(64))).decision, 'allow');
  const r = await decide(env, pyOpens(64, 'CLAUDE.md'));
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /CLAUDE\.md/);
  const strict = await decide(setup(t, { hooks: { strict: true } }), pyOpens(64, 'CLAUDE.md'));
  assert.equal(strict.decision, 'deny');
});

test('python -c: 65 benign write targets are over budget and ask (deny in strict)', async (t) => {
  assert.equal((await decide(setup(t), pyOpens(65))).decision, 'ask');
  assert.equal((await decide(setup(t, { hooks: { strict: true } }), pyOpens(65))).decision, 'deny');
});
