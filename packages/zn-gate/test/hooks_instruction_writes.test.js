'use strict';

// Writes to the files where an agent keeps memory and standing instructions (CLAUDE.md, AGENTS.md, .cursor/rules,
// the Claude Code memory folders...) ask the user; strict mode refuses them; reads and other files are unchanged;
// {"hooks": {"agentInstructionWrites": "off"}} turns the check off. Nothing here touches the real home.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const policy = require('../lib/hooks/policy');
const runner = require('../lib/hooks/runner');
const { getAdapter } = require('../lib/agents');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const claude = getAdapter('claude-code');

function setup(t, config) {
  const home = tempDir(t, 'zn-instr-');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  if (config !== undefined) {
    fs.mkdirSync(path.join(home, '.zn'));
    fs.writeFileSync(path.join(home, '.zn', 'config.json'), JSON.stringify(config));
  }
  return { home, proj };
}

async function decide(env, tool, input) {
  const raw = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: env.proj, session_id: 's' };
  const res = await runner.handle(claude, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'zn run --', home: env.home });
  const o = res.output && res.output.hookSpecificOutput;
  return { decision: o ? o.permissionDecision : 'allow', reason: o ? o.permissionDecisionReason : '' };
}

const FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md', 'MEMORY.md', 'SOUL.md', '.cursorrules', '.windsurfrules',
  '.cursor/rules/x.mdc', '.cursor/rules/deep/y.mdc', '.github/copilot-instructions.md', 'sub/dir/AGENTS.md'];

test('Write to an instruction file asks, with a short message', async (t) => {
  const env = setup(t);
  for (const f of FILES) {
    const r = await decide(env, 'Write', { file_path: path.join(env.proj, f), content: 'Example instruction.' });
    assert.equal(r.decision, 'ask', f);
    assert.match(r.reason, /standing instructions in later sessions\. Approve only if you asked for this change\./, f);
  }
  const edit = await decide(env, 'Edit', { file_path: path.join(env.proj, '.cursor', 'rules', 'x.mdc'), old_string: 'a', new_string: 'b' });
  assert.equal(edit.decision, 'ask');
  const multi = await decide(env, 'MultiEdit', { file_path: path.join(env.proj, 'CLAUDE.md'), edits: [{ old_string: 'a', new_string: 'b' }] });
  assert.equal(multi.decision, 'ask');
  const nb = await decide(env, 'NotebookEdit', { notebook_path: path.join(env.proj, 'AGENTS.md'), new_source: 'x' });
  assert.equal(nb.decision, 'ask');
});

test('the Claude Code user files and memory folders ask', async (t) => {
  const env = setup(t);
  for (const f of ['.claude/projects/-work-app/memory/MEMORY.md', '.claude/projects/-work-app/memory/notes.md']) {
    const r = await decide(env, 'Write', { file_path: path.join(env.home, f), content: 'x' });
    assert.equal(r.decision, 'ask', f);
  }
  const rel = await decide(env, 'Write', { file_path: '~/.claude/projects/p/memory/a.md', content: 'x' });
  assert.equal(rel.decision, 'ask');
  // ~/.claude/CLAUDE.md sits directly in the agent configuration folder, which zn already protects (a refusal).
  assert.equal((await decide(env, 'Write', { file_path: path.join(env.home, '.claude', 'CLAUDE.md'), content: 'x' })).decision, 'deny');
});

test('shell redirections, tee, cp, mv and in-place edits that target an instruction file ask', async (t) => {
  const env = setup(t);
  for (const command of [
    'echo hi >> AGENTS.md',
    'echo hi > CLAUDE.md',
    'cat notes.txt | tee -a .cursor/rules/x.mdc',
    'cp draft.md CLAUDE.md',
    'mv draft.md ./sub/GEMINI.md',
    'sed -i s/a/b/ AGENTS.md',
    'printf x | sudo tee MEMORY.md',
    'dd if=draft.md of=SOUL.md',
    'bash -c "echo hi >> AGENTS.md"',
    "cat <<'EOF' > .cursorrules\nExample.\nEOF",
  ]) {
    const r = await decide(env, 'Bash', { command });
    assert.equal(r.decision, 'ask', command);
    assert.match(r.reason, /standing instructions/, command);
  }
});

test('reading an instruction file, and other writes, are unchanged', async (t) => {
  const env = setup(t);
  assert.equal((await decide(env, 'Read', { file_path: path.join(env.proj, 'CLAUDE.md') })).decision, 'allow');
  for (const command of ['cat CLAUDE.md', 'grep -n foo AGENTS.md', 'cp CLAUDE.md /backup/CLAUDE.md.bak', 'sed -n 1,5p AGENTS.md',
    'git diff CLAUDE.md', 'ls .cursor/rules', 'echo hi > notes.txt', 'tee out.log', 'cp a.txt b.txt']) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'allow', command);
  }
  for (const f of ['src/app.js', 'README.md', 'docs/CLAUDE.md.txt', 'rules/x.mdc']) {
    assert.equal((await decide(env, 'Write', { file_path: path.join(env.proj, f), content: 'x' })).decision, 'allow', f);
  }
});

test('strict mode refuses the write (config file or ZN_STRICT=1)', async (t) => {
  const env = setup(t, { hooks: { strict: true } });
  const w = await decide(env, 'Write', { file_path: path.join(env.proj, 'CLAUDE.md'), content: 'x' });
  assert.equal(w.decision, 'deny');
  assert.match(w.reason, /standing instructions/);
  assert.equal((await decide(env, 'Bash', { command: 'echo hi >> AGENTS.md' })).decision, 'deny');
  assert.equal((await decide(env, 'Read', { file_path: path.join(env.proj, 'CLAUDE.md') })).decision, 'allow');
  assert.equal((await decide(setup(t, { hooks: { agentInstructionWrites: 'deny' } }), 'Edit', { file_path: 'AGENTS.md' })).decision, 'deny');

  const plain = setup(t);
  const before = process.env.ZN_STRICT;
  process.env.ZN_STRICT = '1';
  try {
    assert.equal((await decide(plain, 'Write', { file_path: path.join(plain.proj, 'CLAUDE.md'), content: 'x' })).decision, 'deny');
    // The environment only adds protection: it also wins over a config that turns the check off.
    const off = setup(t, { hooks: { agentInstructionWrites: 'off' } });
    assert.equal((await decide(off, 'Write', { file_path: path.join(off.proj, 'CLAUDE.md'), content: 'x' })).decision, 'deny');
  } finally {
    if (before === undefined) delete process.env.ZN_STRICT; else process.env.ZN_STRICT = before;
  }
  process.env.ZN_STRICT = '0';
  try {
    assert.equal((await decide(plain, 'Write', { file_path: path.join(plain.proj, 'CLAUDE.md'), content: 'x' })).decision, 'ask');
  } finally {
    if (before === undefined) delete process.env.ZN_STRICT; else process.env.ZN_STRICT = before;
  }
});

test('the switch turns the check off', async (t) => {
  for (const value of ['off', false, 'allow']) {
    const env = setup(t, { hooks: { agentInstructionWrites: value } });
    assert.equal((await decide(env, 'Write', { file_path: path.join(env.proj, 'CLAUDE.md'), content: 'x' })).decision, 'allow', String(value));
    assert.equal((await decide(env, 'Bash', { command: 'echo hi >> AGENTS.md' })).decision, 'allow', String(value));
  }
});

test('a protected path still wins over the question, and a link to an instruction file asks', { skip: process.platform === 'win32' }, async (t) => {
  const env = setup(t);
  const hooks = await decide(env, 'Write', { file_path: path.join(env.home, '.claude', 'settings.json'), content: '{}' });
  assert.equal(hooks.decision, 'deny');
  fs.writeFileSync(path.join(env.proj, 'AGENTS.md'), 'x\n');
  fs.symlinkSync(path.join(env.proj, 'AGENTS.md'), path.join(env.proj, 'notes.txt'));
  assert.equal((await decide(env, 'Write', { file_path: path.join(env.proj, 'notes.txt'), content: 'x' })).decision, 'ask');
});

test('policy notice: names the file and is null for other files', (t) => {
  const env = setup(t);
  const n = policy.instructionWriteNotice('CLAUDE.md', { home: env.home, cwd: env.proj, env: {} });
  assert.match(n.ask, /^zn: this writes to CLAUDE\.md, which your agent reads as standing instructions in later sessions\./);
  assert.equal(policy.instructionWriteNotice('src/a.js', { home: env.home, cwd: env.proj, env: {} }), null);
  assert.ok(policy.INSTRUCTION_FILE_NAMES.includes('MEMORY.md'));
});
