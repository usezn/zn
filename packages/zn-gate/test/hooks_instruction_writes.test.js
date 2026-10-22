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

test('a word that only looks like a writer is not read as one: reads stay allowed', async (t) => {
  const env = setup(t);
  for (const command of ['grep -n patch CLAUDE.md', 'rg -n "touch" CLAUDE.md', 'grep -c ed AGENTS.md', 'echo tee CLAUDE.md',
    'sudo grep patch CLAUDE.md', 'FOO=1 grep -n install AGENTS.md', 'xargs grep ln CLAUDE.md']) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'allow', command);
  }
});

test('a writer after sudo, env, nohup, time or a variable assignment is still the command word', async (t) => {
  const env = setup(t);
  for (const command of ['sudo -u root tee AGENTS.md', 'sudo cp draft.md CLAUDE.md', 'env FOO=1 cp draft.md CLAUDE.md',
    'nohup cp draft.md CLAUDE.md', 'time cp draft.md CLAUDE.md', 'FOO=1 cp draft.md CLAUDE.md', 'echo x | xargs -n 1 tee AGENTS.md']) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'ask', command);
  }
});

test('a directory destination: the file lands under its own name', async (t) => {
  const env = setup(t);
  fs.mkdirSync(path.join(env.proj, 'sub'));
  for (const command of ['cp CLAUDE.md sub/', 'cp CLAUDE.md sub', 'mv ./AGENTS.md sub/', 'cp notes.md ~/.claude/projects/p/memory/',
    'cp -t sub CLAUDE.md', 'cp --target-directory=sub CLAUDE.md', 'cp --target-directory sub AGENTS.md', 'install -t sub/ GEMINI.md']) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'ask', command);
  }
  for (const command of ['cp notes.md sub/', 'cp notes.md sub', 'cp -t sub notes.md', 'cp CLAUDE.md sub/backup.md', 'cp a.txt b.txt c.txt sub/',
    'cp notes.md /not/a/memory/folder/']) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'allow', command);
  }
});

test('curl and wget write the file named by their output option', async (t) => {
  const env = setup(t);
  for (const command of ['curl -sSo AGENTS.md https://example.com/a', 'curl -o CLAUDE.md https://example.com/a',
    'curl --output AGENTS.md https://example.com/a', 'curl --output=CLAUDE.md https://example.com/a', 'curl -sS -oAGENTS.md https://example.com/a',
    'wget -O CLAUDE.md https://example.com/a', 'wget -qO AGENTS.md https://example.com/a', 'wget --output-document=CLAUDE.md https://example.com/a',
    'wget --output-document AGENTS.md https://example.com/a', 'sudo curl -o .cursor/rules/x.mdc https://example.com/a']) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'ask', command);
  }
  for (const command of ['curl -sS -o out.txt https://example.com/a', 'curl https://example.com/AGENTS.md', 'wget -O notes.txt https://example.com/CLAUDE.md',
    'curl -H "x: AGENTS.md" https://example.com/a', 'wget -O - https://example.com/a', 'curl -o - https://example.com/a | grep CLAUDE.md']) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'allow', command);
  }
});

test('sponge, awk -i inplace, dd of=, install and ln -sf onto an instruction file ask like a redirect', async (t) => {
  const env = setup(t);
  for (const command of ['grep -v old CLAUDE.md | sponge CLAUDE.md', 'echo x | sponge -a AGENTS.md', 'sed s/a/b/ CLAUDE.md | sudo sponge CLAUDE.md',
    "awk -i inplace '{print}' CLAUDE.md", "gawk -i inplace '/x/' AGENTS.md", "awk -iinplace '1' CLAUDE.md", "awk --include inplace '1' AGENTS.md",
    "awk --include=inplace '1' CLAUDE.md", `awk '@include "inplace"; 1' CLAUDE.md`, "sudo awk -i inplace.awk '1' .cursorrules",
    'dd of=CLAUDE.md', 'echo x | dd of=AGENTS.md conv=notrunc', 'dd if=notes.md of=./CLAUDE.md bs=1M', 'dd of="GEMINI.md"',
    'install -m 644 draft.md CLAUDE.md', 'install -m 0644 -o root draft.md AGENTS.md', 'sudo install -m 600 draft.md .cursorrules',
    'ln -sf draft.md CLAUDE.md', 'ln -sf /tmp/example/draft.md AGENTS.md', 'ln -s draft.md .cursor/rules/x.mdc', 'ln -sf ../CLAUDE.md .']) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'ask', command);
  }
});

test('lookalikes of those forms are allowed', async (t) => {
  const env = setup(t);
  for (const command of ['grep -v old notes.txt | sponge /tmp/example/out.txt', 'sponge /tmp/example/out.txt', 'grep a CLAUDE.md | sponge out.txt',
    "awk '{print}' CLAUDE.md", "awk -F, '{print $1}' AGENTS.md", "awk -i inplace '1' notes.txt", "awk -v inplace=1 '1' CLAUDE.md",
    "gawk -f prog.awk CLAUDE.md", 'cat CLAUDE.md | awk 1',
    'dd of=/dev/null', 'dd if=CLAUDE.md of=/dev/null', 'dd if=CLAUDE.md of=backup.bin', 'dd if=/dev/zero of=out.img bs=1M count=1',
    'install -m 644 CLAUDE.md /tmp/example/CLAUDE.copy', 'install -m 644 draft.md notes.txt',
    'ln -sf draft.md notes.txt', 'ln -sf CLAUDE.md notes.txt', 'ln -s AGENTS.md AGENTS.link', 'ln -sf /tmp/example/a /tmp/example/b']) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'allow', command);
  }
});

test('tee and redirects through a variable set in the same command', async (t) => {
  const env = setup(t);
  for (const command of ['F=CLAUDE.md; echo x | tee -a "$F"', 'F=AGENTS.md && echo x | tee -a ${F}', 'F="CLAUDE.md"; echo x >> "$F"',
    'export F=CLAUDE.md; echo x | tee -a $F', 'F=sub/AGENTS.md; D=.; echo x | tee "$F"', 'D=sub; F=$D/AGENTS.md; echo x | tee -a "$F"',
    'F=notes.txt; F=CLAUDE.md; echo x | tee -a "$F"', 'F=CLAUDE.md; echo x | sponge "$F"', 'F=CLAUDE.md; dd of="$F"', 'F=CLAUDE.md; cp draft.md "$F"',
    'F=CLAUDE.md; awk -i inplace 1 "$F"', 'F=CLAUDE.md; ln -sf draft.md "$F"', 'F=CLAUDE.md' + String.fromCharCode(10) + 'echo x | tee -a "$F"']) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'ask', command);
  }
  for (const command of ['F=notes.txt; echo x | tee -a "$F"', 'F=CLAUDE.md; echo "$F" | tee out.txt', 'F=CLAUDE.md; cat "$F" | tee -a notes.txt',
    'F=CLAUDE.md; grep x "$F"', 'echo x | tee -a "$UNSET"', 'F=notes.txt; G=CLAUDE.md; echo x | tee -a "$F"']) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'allow', command);
  }
});

test('the new forms are refused in strict mode', async (t) => {
  const env = setup(t, { hooks: { strict: true } });
  for (const command of ['echo x | sponge CLAUDE.md', "awk -i inplace 1 AGENTS.md", 'dd of=CLAUDE.md', 'F=CLAUDE.md; tee -a "$F"']) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'deny', command);
  }
});
