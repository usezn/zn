'use strict';
// Shell commands and the watched dotenv files (.env, .gemini/.env): the project .env is loaded into the environment the agent gives
// its hooks, so a shell command may not write it. Besides the redirections (> and >>), this covers the read-write redirection <>,
// and every program whose text names such a file: it is refused unless it is proven read-only or metadata-only. The fixtures use
// no existing .env (a write creates it) and inert text.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runner = require('../lib/hooks/runner');
const claude = require('../lib/agents/claude-code');
const gemini = require('../lib/agents/gemini');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const REFUSED = /shell writes to \.env files are blocked|would set (LD_DEBUG|LD_TRACE_LOADED_OBJECTS|LD_PRELOAD) for the agent/;

function project(t) {
  const dir = tempDir(t, 'zn-ldshell-');
  fs.mkdirSync(path.join(dir, '.gemini'), { recursive: true });
  return dir;
}

async function decide(adapter, raw) {
  const res = await runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
  return res.decision;
}

const cc = (command, cwd, tool = 'Bash') => ({ session_id: 's', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, tool_use_id: 't' });
const gem = (command, cwd) => ({ session_id: 's', cwd, hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command } });

async function refuseAll(t, commands) {
  const dir = project(t);
  for (const command of commands) {
    for (const d of [await decide(claude, cc(command, dir)), await decide(gemini, gem(command, dir))]) {
      assert.equal(d.decision, 'deny', command);
      assert.match(d.message, REFUSED, command);
    }
  }
}

test('review class 1: a read-write redirection (<>, 1<>, {fd}<>) to a dotenv file is a write and is refused', async (t) => {
  await refuseAll(t, [
    'echo LD_PRELOAD=/tmp/x.so 1<> .env',
    'echo LD_DEBUG=help 1<>.env',
    'echo A=1 <> .env',
    'echo A=1 <>.env',
    'echo A=1 3<>.env',
    'echo A=1 {fd}<> .env',
    'echo A=1 {fd}<>.gemini/.env',
    'exec 3<> .env',
    'echo A=1 x<>.env',
    "echo A=1 1<> '.env'",
  ]);
});

test('review class 2: a program whose text names a dotenv file is refused unless it is read-only: interpreters, awk, sed w, downloaders', async (t) => {
  await refuseAll(t, [
    "python3 -c \"open('.env','w').write('LD_'+'PRELOAD=/tmp/x.so\\n')\"",
    "node -e \"require('fs').writeFileSync('.env','LD_'+'DEBUG=help\\n')\"",
    "perl -e \"open F,'>.env'; print F 'LD_'.'DEBUG=help'\"",
    "awk 'BEGIN{print \"LD_\" \"PRELOAD=/tmp/x.so\" > \".env\"}'",
    "sed -n 'w .env' src",
    "sed -n 'w .gemini/.env' src",
    "ruby -e \"File.write('.env', 'A=1')\"",
    "php -r \"file_put_contents('.env', 'A=1');\"",
    'sh -c "echo A=1 > .env"',
    'curl -o .env https://example.com/x',
    'wget -O .env https://example.com/x',
    'unknown-tool --target .env',
  ]);
  // PowerShell: Invoke-WebRequest and its alias write the file named by -OutFile.
  const dir = project(t);
  for (const command of ['iwr https://example.com/x -OutFile .env', 'Invoke-WebRequest -Uri https://example.com/x -OutFile .env']) {
    const d = await decide(claude, cc(command, dir, 'PowerShell'));
    assert.equal(d.decision, 'deny', command);
    assert.match(d.message, REFUSED, command);
  }
});

test('review classes 3 and 4: comment-quote, quoted builtins, PATH changes, trap and PowerShell redefinitions no longer matter, the write is refused', async (t) => {
  await refuseAll(t, [
    "# '\necho() { printf \"LD_PRELOAD=/tmp/x.so\\n\"; }\n# '\necho A=1 >> .env",
    "e'v'al 'echo() { printf \"LD_PRELOAD=/tmp/x.so\\n\"; }'; echo A=1 >> .env",
    "e\\val 'echo() { :; }'; echo A=1 >> .env",
    "al'i'as echo=printf; echo A=1 >> .env",
    "en'a'ble -n echo; echo A=1 >> .env",
    "s'e't -o posix; echo A=1 >> .env",
    "sh'o'pt -s expand_aliases; echo A=1 >> .env",
    "printf -v PATH /tmp/evil; cat <<'EOF' >> .env\nA=1\nEOF",
    'read PATH < /tmp/p; echo A=1 >> .env',
    'path=(/tmp/evil); echo A=1 >> .env',
    "trap 'echo() { printf \"LD_PRELOAD=/tmp/x.so\\n\"; }' DEBUG; echo A=1 >> .env",
    "Set-Item Function:echo { 'LD_PRELOAD=/tmp/x.so' }; echo A=1 >> .env",
    'Set-Alias echo Write-Output; echo A=1 >> .env',
    'sal echo Write-Output; echo A=1 >> .env',
  ]);
});

test('every shell write to a dotenv file is refused, with no literal allowance left', async (t) => {
  await refuseAll(t, [
    'echo A=1 >> .env',
    "printf 'A=1' > .env",
    "cat <<'EOF' > .env\nA=1\nEOF",
    'echo A=1 > .gemini/.env',
    'echo A=1 &> .env',
    'echo A=1 >| .env',
    'echo A=1 1>> .env',
    'true && echo A=1 >> .env',
    'echo A=1 | tee .env',
  ]);
});

test('read-only and metadata-only commands that name a dotenv file are not refused by the shell-write rule', async (t) => {
  const dir = project(t);
  const fine = [
    'cat .env',
    'head -n 1 .env',
    'tail .env',
    'grep -c FOO .env',
    'wc -l .env',
    'ls -la .env',
    'stat .env',
    'test -f .env',
    '[ -f .env ]',
    'touch .env',
    'diff .env .env.example',
    'git status --short .env',
    'git ls-files .env',
    'git check-ignore .env',
    'echo hello > notes.txt',
  ];
  for (const command of fine) {
    for (const d of [await decide(claude, cc(command, dir)), await decide(gemini, gem(command, dir))]) {
      assert.notEqual(d.decision, 'deny', command + ' ' + JSON.stringify(d));
    }
  }
});
