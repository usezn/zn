'use strict';
// A shell command that writes a .env the agent loads (Gemini CLI reads the project .env and .gemini/.env) is allowed only when what it
// writes is literal text: echo or printf as the first word, with no %, backslash, $, substitution, glob or prefix, or a here-document
// with a quoted delimiter. Everything else that writes such a file is refused, because zn cannot see what it writes. Fixtures are inert.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runner = require('../lib/hooks/runner');
const claude = require('../lib/agents/claude-code');
const gemini = require('../lib/agents/gemini');
const loaderEnv = require('../lib/loader-env');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const OPAQUE = /zn cannot check what this command writes to it\. Use a literal assignment \(echo NAME=value >> \.env\) or edit the file with the editor tool/;
const NAMED = /would set (LD_DEBUG|LD_TRACE_LOADED_OBJECTS|LD_PRELOAD) for the agent/;

function project(t) {
  const dir = tempDir(t, 'zn-ldliteral-');
  fs.mkdirSync(path.join(dir, '.gemini'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  return dir;
}

async function decide(adapter, raw) {
  const res = await runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
  return res.decision;
}

const cc = (command, cwd) => ({ session_id: 's', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 't' });
const gem = (command, cwd) => ({ session_id: 's', cwd, hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command } });

async function both(dir, command) {
  return [await decide(claude, cc(command, dir)), await decide(gemini, gem(command, dir))];
}

test('literal echo, printf and quoted here-document writes to a .env pass', async (t) => {
  const dir = project(t);
  const fine = [
    'echo API_URL=https://example.com >> .env',
    "echo 'TOKEN=abc' >> .env",
    "printf 'A=1' >> .env",
    'echo "X=hello world" > .env',
    "cat <<'EOF' > .env\nA=1\nB=two words\nEOF",
    'cat > .gemini/.env <<"EOF"\nA=1\nEOF\necho done',
    'cd sub && echo FOO=1 >> .env',
    'npm test > out.log; echo A=1 >> .env',
    'echo A=1 >> .env 2>/dev/null',
    'echo LD_DEBUG=all >> .env',
    'echo LD_PRELOAD= >> .env',
    'touch .env',
  ];
  for (const command of fine) for (const d of await both(dir, command)) assert.notEqual(d.decision, 'deny', command + ' ' + JSON.stringify(d));
});

test('printf with a format, behind a wrapper or prefix, or quoted as a word is refused', async (t) => {
  const dir = project(t);
  const bad = [
    "printf '%0000000bLD_%s=%s\\n' x DEBUG help > .env",
    "printf '%b' 'A=1' > .env",
    "printf '%-8b' 'A=1' > .env",
    "env printf 'A=1' > .env",
    "X=1 printf 'A=1' > .env",
    "command printf 'A=1' > .env",
    "builtin printf 'A=1' > .env",
    "sudo printf 'A=1' > .env",
    "\"printf\" 'A=1' > .env",
    "\\printf 'A=1' > .env",
    "printf '%s%s\\n' LD_ DEBUG=help > .env",
    "printf 'A=1\\n' > .env",
    'printf "$X" > .env',
    "printf -v V 'A=1' > .env",
    "printf 'A=1' 'B=2' > .env",
  ];
  for (const command of bad) {
    for (const d of await both(dir, command)) {
      assert.equal(d.decision, 'deny', command);
      assert.match(d.message, /zn cannot check what this command writes|would set LD_DEBUG for the agent/, command);
    }
  }
});

test('expansions, substitutions, globs, echo options and multi-line arguments are refused', async (t) => {
  const dir = project(t);
  // Policy changed (2026-11-25): echo "API_URL=$URL" >> .env used to pass because only a value was expanded.
  const bad = [
    'echo "API_URL=$URL" >> .env',
    "echo 'A=$NOT_EXPANDED' >> .env",
    "echo -e 'A=1\\nLD_DEBUG=help' >> .env",
    'echo -n A=1 >> .env',
    'echo -E A=1 >> .env',
    'echo `id` > .env',
    'echo $(id) > .env',
    "echo $'A=1' > .env",
    'echo A* > .env',
    'echo {A,B}=1 > .env',
    'echo A=~/x > .env',
    "echo 'A=1\nB=2' > .env",
    'echo A=1 > "$D/.env"',
    'echo A=1 > .en?',
  ];
  for (const command of bad) {
    for (const d of await both(dir, command)) {
      assert.equal(d.decision, 'deny', command);
      assert.match(d.message, /zn cannot check what this command writes|would set LD_DEBUG for the agent/, command);
    }
  }
});

test('copies, other writers and unquoted here-documents are refused: zn cannot see what they write', async (t) => {
  const dir = project(t);
  const bad = [
    'cp "$SRC" .env',
    'cp x .env',
    'cat x > .env',
    'tee .env < x',
    'echo A=1 | tee -a .env',
    "sed -i 's/a/b/' .env",
    'dd if=x of=.env',
    'mv x .env',
    'curl -o .env https://example.com/x',
    'cat > .env <<EOF\n$X\nEOF',
    'cat > .env <<EOF\nA=1\nEOF',
    "cat > .env <<'EOF'\nA=$X\nEOF",
    "cat > .env <<'EOF'\nA=1\n",
    "cat > .env <<-'EOF'\nA=1\nEOF",
    "cat > .env <<'EOF'\nA=100%\nEOF",
    "cat > .env <<'EOF'\nA=x\\y\nEOF",
    "cat > .env <<'EOF'\nA=`id`\nEOF",
  ];
  for (const command of bad) for (const d of await both(dir, command)) { assert.equal(d.decision, 'deny', command); assert.match(d.message, OPAQUE, command); }
  assert.match((await decide(claude, cc('cp x .env', dir))).message, /a copy from another file is refused/);
  for (const command of ["Set-Content .env 'A=1'", "Add-Content -Path .env -Value 'A=1'", "'A=1' | Out-File .env"]) {
    const d = await decide(claude, { session_id: 's', cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command }, tool_use_id: 't' });
    assert.equal(d.decision, 'deny', command);
    assert.match(d.message, OPAQUE, command);
  }
});

test('literal writes that set a loader variable keep their own refusal', async (t) => {
  const dir = project(t);
  const bad = [
    'echo LD_DEBUG=help > .env',
    'echo LD_TRACE_LOADED_OBJECTS=1 >> .env',
    'echo LD_PRELOAD=/tmp/x.so >> .env',
    "echo 'LD_'\"DEBUG\"=help >> .env",
    'echo LD_DEBUG="all" help >> .env',
    "cat <<'EOF' >> .env\nLD_TRACE_LOADED_OBJECTS=1\nEOF",
    "printf 'LD_DEBUG: help' > .gemini/.env",
    'echo A=1 > .env; echo LD_DEBUG=help > .env',
  ];
  for (const command of bad) for (const d of await both(dir, command)) { assert.equal(d.decision, 'deny', command); assert.match(d.message, NAMED, command); }
});

test('shellDotenvWrite reports the dotenv targets it checked', () => {
  const isEnv = (x) => /(^|[\\/])\.env$/.test(x);
  const ok = loaderEnv.shellDotenvWrite('echo A=1 > .env; echo B=2 >> sub/.env', isEnv);
  assert.equal(ok.verdict, null);
  assert.deepEqual([...ok.targets].sort(), ['.env', 'sub/.env']);
  assert.equal(loaderEnv.shellDotenvWrite('echo A=1 > notes.txt', isEnv).targets.size, 0);
});
