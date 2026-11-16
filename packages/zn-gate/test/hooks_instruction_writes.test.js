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
  for (const f of ['src/app.js', 'README.md', 'notes/CLAUDE.md.txt', 'rules/x.mdc']) {
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

test('>| is a redirection, and timeout, stdbuf, ionice and chronic run the next command', async (t) => {
  const env = setup(t);
  for (const command of ['echo x >|CLAUDE.md', 'echo x >| AGENTS.md', 'echo x 2>|.cursorrules', 'timeout 5 tee CLAUDE.md', 'timeout -k 2 10 tee -a AGENTS.md',
    'stdbuf -o0 tee CLAUDE.md', 'ionice -c3 tee MEMORY.md', 'chronic tee SOUL.md']) {
    const r = await decide(env, 'Bash', { command });
    assert.equal(r.decision, 'ask', command);
    assert.match(r.reason, /standing instructions/, command);
  }
  for (const command of ['echo x >|notes.txt', 'timeout 5 tee out.log', 'timeout 5 cat CLAUDE.md', 'stdbuf -o0 grep -n a AGENTS.md']) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'allow', command);
  }
});

test('PowerShell Copy-Item and Move-Item read -Destination by name', async (t) => {
  const env = setup(t);
  for (const command of ['Copy-Item -Destination CLAUDE.md -Path a.md', 'Copy-Item -Path a.md -Destination AGENTS.md', 'Copy-Item -Dest:CLAUDE.md a.md',
    'Move-Item -Destination .cursorrules -Path a.md']) {
    const r = await decide(env, 'PowerShell', { command });
    assert.equal(r.decision, 'ask', command);
    assert.match(r.reason, /standing instructions/, command);
  }
  for (const command of ['Copy-Item -Path CLAUDE.md -Destination backup.txt', 'Copy-Item -Destination out.txt -Path CLAUDE.md']) {
    assert.equal((await decide(env, 'PowerShell', { command })).decision, 'allow', command);
  }
});

test('a write to an instruction file that carries a secret marker asks once, with both notes', async (t) => {
  const env = setup(t);
  const r = await decide(env, 'Write', { file_path: path.join(env.proj, 'CLAUDE.md'), content: 'key=__ZN_AWS_KEY_1__\n' });
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /standing instructions in later sessions/);
  assert.match(r.reason, /__ZN_AWS_KEY_1__/);
  assert.equal((await decide(setup(t, { hooks: { strict: true } }), 'Write', { file_path: path.join(env.proj, 'CLAUDE.md'), content: 'key=__ZN_AWS_KEY_1__\n' })).decision, 'deny');
});

test('python -c and node -e code that writes a quoted instruction file name asks', async (t) => {
  const env = setup(t);
  const asks = [
    `python3 -c "open('CLAUDE.md','w').write('Example note.')"`,
    `python3 -c 'open("AGENTS.md", "a").write("Example note.")'`,
    `python -c "open('./CLAUDE.md','wb').write(b'Example')"`,
    `python3 -c "open('docs/../CLAUDE.md','x')"`,
    `python3 -c "open('~/notes/CLAUDE.md','w').write('Example')"`,
    `python3 -c "open(file='GEMINI.md', mode='w').write('Example')"`,
    `python3 -c "open('.cursorrules', encoding='utf-8', mode='a')"`,
    `python3 -c "with open('CLAUDE.md','w') as f: f.write('Example')"`,
    `python3 -c "from pathlib import Path; Path('GEMINI.md').write_text('Example')"`,
    `python3 -c "import pathlib; pathlib.Path('.github/copilot-instructions.md').write_bytes(b'Example')"`,
    `python3 -c "from pathlib import Path; Path('.cursor/rules/x.mdc').open('w').write('Example')"`,
    `sudo python3 -c "open('CLAUDE.md','w')"`,
    `node -e "require('fs').writeFileSync('CLAUDE.md','Example')"`,
    `node -e 'require("fs").writeFileSync("AGENTS.md","Example")'`,
    `node -e "require('fs').writeFile('./CLAUDE.md','Example',()=>{})"`,
    `node -e "require('fs').appendFileSync('docs/../CLAUDE.md','Example')"`,
    `node -e "require('fs').appendFile('MEMORY.md','Example',()=>{})"`,
    `node -e "require('fs').promises.writeFile('.windsurfrules','Example')"`,
    `node -e "require('fs').createWriteStream('~/notes/CLAUDE.md').end('Example')"`,
    `node --eval "const fs=require('fs'); fs.writeFileSync('GEMINI.md','Example')"`,
  ];
  for (const command of asks) {
    const r = await decide(env, 'Bash', { command });
    assert.equal(r.decision, 'ask', command);
    assert.match(r.reason, /standing instructions in later sessions\. Approve only if you asked for this change\./, command);
  }
  const strict = setup(t, { hooks: { agentInstructionWrites: 'deny' } });
  assert.equal((await decide(strict, 'Bash', { command: asks[0] })).decision, 'deny');
  assert.equal((await decide(strict, 'Bash', { command: asks[12] })).decision, 'deny');
  const off = setup(t, { hooks: { agentInstructionWrites: 'off' } });
  assert.equal((await decide(off, 'Bash', { command: asks[0] })).decision, 'allow');
});

test('python -c and node -e code that only reads, or writes another file, is allowed', async (t) => {
  const env = setup(t);
  const allows = [
    `python3 -c "print(open('CLAUDE.md').read())"`,
    `python3 -c "print(open('CLAUDE.md','r').read())"`,
    `python3 -c "print(open('CLAUDE.md','rb').read())"`,
    `python3 -c "print(open('CLAUDE.md', mode='r').read())"`,
    `python3 -c "open('notes.txt','w').write('Example')"`,
    `python3 -c "open('docs/CLAUDE.md.txt','w')"`,
    `python3 -c "name='CLAUDE.md'; print(open(name).read())"`,
    `python3 -c "name='CLAUDE.md'; print(open(name,'r').read())"`,
    `python3 -c "from pathlib import Path; p=Path('CLAUDE.md'); print(p.read_text())"`,
    `python3 -c "p='CLAUDE.md'; open(p)"`,
    `python3 -c "from pathlib import Path; print(Path('CLAUDE.md').read_text())"`,
    `python3 -c "from pathlib import Path; Path('notes.txt').write_text('Example')"`,
    `python3 -c "from pathlib import Path; print(Path('AGENTS.md').open('r').read())"`,
    `python3 -c "reopen('CLAUDE.md','w')"`,
    `python3 -c "import json; print(json.dumps({'file': 'CLAUDE.md'}))"`,
    `python3 script.py "open('CLAUDE.md','w')"`,
    `node -e "console.log(require('fs').readFileSync('CLAUDE.md','utf8'))"`,
    `node -e "require('fs').writeFileSync('notes.txt','Example')"`,
    `node -e "const fs=require('fs'); console.log(fs.readFileSync(process.argv[1],'utf8'))"`,
    `node -e "require('fs').createReadStream('CLAUDE.md').pipe(process.stdout)"`,
    `node -e "console.log(require('fs').existsSync('AGENTS.md'))"`,
    `node script.js "fs.writeFileSync('CLAUDE.md','x')"`,
  ];
  for (const command of allows) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'allow', command);
  }
});

test('one-liner code over the scan cap asks (denies in strict mode), also when padded before the write; benign code under the cap is allowed', async (t) => {
  const env = setup(t);
  const strict = setup(t, { hooks: { agentInstructionWrites: 'deny' } });
  const write = `open('AGENTS.md','w').write('Example')`;
  const padded = `python3 -c "${' '.repeat(20001)}${write}"`;
  const direct = `python3 -c "${write}"`;
  assert.equal((await decide(env, 'Bash', { command: direct })).decision, 'ask');
  const r = await decide(env, 'Bash', { command: padded });
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /too long for zn to check/);
  const s = await decide(strict, 'Bash', { command: padded });
  assert.equal(s.decision, 'deny');
  assert.match(s.reason, /too long for zn to check/);
  const nodePadded = `node -e "${' '.repeat(20001)}require('fs').writeFileSync('AGENTS.md','Example')"`;
  assert.equal((await decide(env, 'Bash', { command: nodePadded })).decision, 'ask');
  // Benign long code with no instruction file name, under the cap: allowed.
  const under = `python3 -c "${'x=1;'.repeat(4000)}print(x)"`;
  assert.equal((await decide(env, 'Bash', { command: under })).decision, 'allow');
  // Benign code over the cap cannot be checked in full, so it asks too (documented fail-closed behaviour).
  const over = `python3 -c "${'x=1;'.repeat(6000)}print(x)"`;
  assert.equal((await decide(env, 'Bash', { command: over })).decision, 'ask');
  assert.equal((await decide(strict, 'Bash', { command: over })).decision, 'deny');
  const off = setup(t, { hooks: { agentInstructionWrites: 'off' } });
  assert.equal((await decide(off, 'Bash', { command: over })).decision, 'allow');
});

test('one-liner writes to a quoted Windows path (raw or escaped backslashes) ask; other Windows names and unreadable escapes are handled', async (t) => {
  const env = setup(t);
  const strict = setup(t, { hooks: { agentInstructionWrites: 'deny' } });
  const asks = [
    String.raw`python3 -c 'open(r".\AGENTS.md","w")'`,
    String.raw`python3 -c "open(r'.\AGENTS.md','w')"`,
    String.raw`python3 -c 'open("C:\\proj\\CLAUDE.md","w")'`,
    String.raw`python3 -c 'open(r"C:\proj\sub\CLAUDE.md","a")'`,
    String.raw`python3 -c 'from pathlib import Path; Path(r"..\GEMINI.md").write_text("Example")'`,
    String.raw`python3 -c 'open(r".cursor\rules\x.mdc","w")'`,
    String.raw`node -e 'require("fs").writeFileSync("C:\\proj\\AGENTS.md","Example")'`,
    String.raw`node -e 'require("fs").appendFileSync(".\\CLAUDE.md","Example")'`,
    // A name spelled with escapes cannot be read without running the code: ask.
    String.raw`python3 -c 'open("AGENT\x53.md","w")'`,
    String.raw`node -e 'require("fs").writeFileSync("AGENT\u0053.md","Example")'`,
  ];
  for (const command of asks) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'ask', command);
    assert.equal((await decide(strict, 'Bash', { command })).decision, 'deny', command);
  }
  const allows = [
    String.raw`python3 -c 'open("C:\\proj\\notes.txt","w")'`,
    String.raw`python3 -c 'open(r".\docs\CLAUDE.md.txt","w")'`,
    String.raw`python3 -c 'print(open(r".\AGENTS.md").read())'`,
    String.raw`node -e 'require("fs").writeFileSync("C:\\proj\\notes.txt","Example")'`,
  ];
  for (const command of allows) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'allow', command);
  }
});

test('python -c and node -e code that writes to a file named by a variable or expression asks (denies in strict mode)', async (t) => {
  const env = setup(t);
  const strict = setup(t, { hooks: { agentInstructionWrites: 'deny' } });
  const asks = [
    `python3 -c "p='CLAUDE.md'; open(p,'w').write('x')"`,
    `python3 -c "p='CLAUDE.md'; open(p, mode='a')"`,
    `python3 -c "import os; open(os.path.join('a','b'),'w')"`,
    `python3 -c "p='CLAUDE.md'; open(file=p, mode='w')"`,
    `python3 -c "import io; p='CLAUDE.md'; io.open(p,'w')"`,
    `python3 -c "from pathlib import Path; p='CLAUDE.md'; Path(p).write_text('x')"`,
    `python3 -c "from pathlib import Path; p=Path('CLAUDE.md'); p.write_text('x')"`,
    `python3 -c "from pathlib import Path; p=Path('CLAUDE.md'); p.write_bytes(b'x')"`,
    `python3 -c "from pathlib import Path; p=Path('CLAUDE.md'); p.open('w')"`,
    `node -e "const p='CLAUDE.md'; require('fs').writeFileSync(p,'x')"`,
    `node -e "const p='CLAUDE.md'; require('fs').appendFileSync(p,'x')"`,
    `node -e "require('fs').writeFileSync(process.argv[1],'x')"`,
    `node -e "const p='CLAUDE.md'; require('fs').promises.writeFile(p,'x')"`,
    `node -e "const p='CLAUDE.md'; require('fs').createWriteStream(p)"`,
  ];
  for (const command of asks) {
    const r = await decide(env, 'Bash', { command });
    assert.equal(r.decision, 'ask', command);
    assert.match(r.reason, /cannot tell/, command);
    assert.equal((await decide(strict, 'Bash', { command })).decision, 'deny', command);
  }
  // A named instruction file in the same code is still reported by its name.
  const named = await decide(env, 'Bash', { command: `python3 -c "p='x'; open(p,'w'); open('CLAUDE.md','w')"` });
  assert.equal(named.decision, 'ask');
  assert.match(named.reason, /CLAUDE\.md/);
  assert.equal((await decide(setup(t, { hooks: { agentInstructionWrites: 'off' } }), 'Bash', { command: asks[0] })).decision, 'allow');
});

test('python -c and node -e calls on an instruction file with a mode or flags zn cannot read ask (denies in strict mode)', async (t) => {
  const env = setup(t);
  const strict = setup(t, { hooks: { agentInstructionWrites: 'deny' } });
  const asks = [
    `python3 -c "m='w'; open('CLAUDE.md', m)"`,
    `python3 -c "m='w'; open('CLAUDE.md', mode=m)"`,
    `python3 -c "m='w'; open(file='CLAUDE.md', mode=m)"`,
    `python3 -c "m='w'; open('CLAUDE.md', 'w' if m else 'r')"`,
    `python3 -c "a=('w',); open('CLAUDE.md', *a)"`,
    `python3 -c "k={'mode':'w'}; open('CLAUDE.md', **k)"`,
    `python3 -c "import io; m='w'; io.open('CLAUDE.md', m)"`,
    `python3 -c "import codecs; m='w'; codecs.open('CLAUDE.md', m)"`,
    `python3 -c "from pathlib import Path; m='w'; Path('CLAUDE.md').open(m)"`,
    `python3 -c "from pathlib import Path; m='w'; Path('CLAUDE.md').open(mode=m)"`,
    `node -e "const f='w'; require('fs').openSync('CLAUDE.md', f)"`,
    `node -e "const fs=require('fs'); const f='w'; fs.openSync('CLAUDE.md', f)"`,
    `node -e "const f='w'; require('fs').open('AGENTS.md', f, ()=>{})"`,
    `node -e "const f='w'; require('fs').promises.open('CLAUDE.md', f)"`,
    `node -e "require('fs').openSync('CLAUDE.md', 'w')"`,
    `node -e "require('fs').openSync('CLAUDE.md', 'a+')"`,
  ];
  for (const command of asks) {
    const r = await decide(env, 'Bash', { command });
    assert.equal(r.decision, 'ask', command);
    assert.match(r.reason, /CLAUDE\.md|AGENTS\.md/, command);
    assert.equal((await decide(strict, 'Bash', { command })).decision, 'deny', command);
  }
  // A target that is not a literal, with flags that are not a literal either, cannot be told.
  for (const command of [
    `node -e "const p='CLAUDE.md', f='w'; require('fs').openSync(p, f)"`,
    `python3 -c "p='CLAUDE.md'; m='w'; open(p, m)"`,
  ]) {
    const r = await decide(env, 'Bash', { command });
    assert.equal(r.decision, 'ask', command);
    assert.match(r.reason, /cannot tell/, command);
  }
  // Reads, and other files, are left alone.
  for (const command of [
    `python3 -c "print(open('CLAUDE.md').read())"`,
    `python3 -c "open('CLAUDE.md', 'r')"`,
    `python3 -c "open('CLAUDE.md', encoding='utf-8')"`,
    `python3 -c "open('CLAUDE.md', 'rb', 0)"`,
    `python3 -c "m='w'; open('notes.txt', m)"`,
    `python3 -c "from pathlib import Path; m='w'; Path('notes.txt').open(m)"`,
    `node -e "require('fs').openSync('CLAUDE.md', 'r')"`,
    `node -e "require('fs').openSync('CLAUDE.md')"`,
    `node -e "const f='w'; require('fs').openSync('notes.txt', f)"`,
  ]) {
    assert.equal((await decide(env, 'Bash', { command })).decision, 'allow', command);
  }
});

test('python -c f-strings and node template literals with a replacement field are not literal write targets', async (t) => {
  const env = setup(t);
  const strict = setup(t, { hooks: { agentInstructionWrites: 'deny' } });
  const asks = [
    `python3 -c "from pathlib import Path; name='CLAUDE.md'; Path(f'{name}').write_text('x')"`,
    `python3 -c "from pathlib import Path; name='CLAUDE'; Path(f'{name}.md').write_bytes(b'x')"`,
    `python3 -c "from pathlib import Path; name='CLAUDE.md'; Path(rf'{name}').write_text('x')"`,
    `python3 -c "from pathlib import Path; name='CLAUDE.md'; Path(fr'{name}').write_text('x')"`,
    `python3 -c "from pathlib import Path; name='CLAUDE.md'; Path(F'{name}').write_text('x')"`,
    `python3 -c "name='CLAUDE.md'; open(f'{name}', 'w')"`,
    `python3 -c "name='CLAUDE.md'; open(file=f'{name}', mode='w')"`,
    `python3 -c "import io; name='CLAUDE.md'; io.open(f'{name}', 'w')"`,
    `python3 -c "from pathlib import Path; name='CLAUDE.md'; Path(f'{name}').open('w')"`,
    `node -e "const name='CLAUDE.md'; require('fs').writeFileSync(\`\${name}\`,'x')"`,
    `node -e "const name='CLAUDE'; require('fs').appendFileSync(\`\${name}.md\`,'x')"`,
  ];
  for (const command of asks) {
    const r = await decide(env, 'Bash', { command });
    assert.equal(r.decision, 'ask', command);
    assert.match(r.reason, /cannot tell/, command);
    assert.equal((await decide(strict, 'Bash', { command })).decision, 'deny', command);
  }
  // An f-string without a replacement field is a literal name, and reads stay allowed.
  const plain = await decide(env, 'Bash', { command: `python3 -c "from pathlib import Path; Path(f'CLAUDE.md').write_text('x')"` });
  assert.equal(plain.decision, 'ask');
  assert.match(plain.reason, /CLAUDE\.md/);
  assert.doesNotMatch(plain.reason, /cannot tell/);
  assert.equal((await decide(env, 'Bash', { command: `python3 -c "name='CLAUDE.md'; print(open(f'{name}').read())"` })).decision, 'allow');
  assert.equal((await decide(env, 'Bash', { command: `python3 -c "from pathlib import Path; n='x'; Path(f'{n}.txt').write_text('x')"` })).decision, 'ask');
});
