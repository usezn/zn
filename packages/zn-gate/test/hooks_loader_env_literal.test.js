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

const REDEFINES = /This command can redefine echo, printf or cat/;
const REFUSED = /zn cannot check what this command writes to it|would set (LD_DEBUG|LD_TRACE_LOADED_OBJECTS|LD_PRELOAD)/;

// Each command must be refused on both adapters; `redefine` also checks the reason clause (skipped for commands that name a loader variable).
async function refuseAll(t, commands, redefine) {
  const dir = project(t);
  for (const command of commands) {
    for (const d of await both(dir, command)) {
      assert.equal(d.decision, 'deny', command);
      assert.match(d.message, REFUSED, command);
      if (redefine && !/LD_PRELOAD/.test(command)) assert.match(d.message, REDEFINES, command);
    }
  }
}

test('redefinition class function: a function definition anywhere in the command refuses the dotenv write', async (t) => {
  await refuseAll(t, [
    "echo() { printf 'LD_PRELOAD=x\\n'; }; echo A=1 >> .env",
    'echo() { :; }; echo A=1 >> .env',
    'echo () { :; }; echo A=1 >> .env',
    'function echo { :; }; echo A=1 > .env',
    'printf() { :; }; printf A=1 >> .env',
    'echo A=1 > .env; echo() { :; }',
  ], true);
});

test('redefinition class alias: alias and unalias anywhere in the command refuse the dotenv write', async (t) => {
  await refuseAll(t, ['alias echo=printf; echo A=1 >> .env', 'unalias echo; echo A=1 >> .env', "cat <<'EOF' > .env\nA=1\nEOF\nalias cat=true"], true);
});

test('redefinition class eval, source, dot and exec refuse the dotenv write', async (t) => {
  await refuseAll(t, [
    'eval true; echo A=1 > .env',
    'source ./x.sh; echo A=1 >> .env',
    '. ./x.sh && echo A=1 >> .env',
    'echo A=1 >> .env; . ./x.sh',
    'exec true; echo A=1 > .env',
  ], true);
});

test('redefinition class builtin switches: enable, hash, declare, set -o, shopt, builtin of anything but echo or printf refuse the write', async (t) => {
  await refuseAll(t, [
    'enable -n echo; echo A=1 > .env',
    'hash -p /tmp/x echo; echo A=1 > .env',
    'declare -f echo; echo A=1 > .env',
    'typeset -f echo; echo A=1 > .env',
    'readonly -f echo; echo A=1 > .env',
    'shopt -s expand_aliases; echo A=1 > .env',
    'set -o posix; echo A=1 > .env',
    'builtin true; echo A=1 > .env',
    'builtin command echo A=1 >> .env',
  ], true);
});

test('redefinition class lookup variables: PATH, BASH_ENV and ENV assignments refuse the write', async (t) => {
  await refuseAll(t, [
    'export PATH=/tmp/bin; echo A=1 >> .env',
    'PATH=/tmp/bin; echo A=1 >> .env',
    'PATH+=:/tmp/bin; echo A=1 >> .env',
    'BASH_ENV=/tmp/x; echo A=1 > .env',
    'ENV=/tmp/x; echo A=1 > .env',
  ], true);
});

test('redefinition class here-string and process substitution: <<<, <( ) and >( ) anywhere refuse the write', async (t) => {
  await refuseAll(t, [
    'cat <<< x; echo A=1 >> .env',
    'echo A=1 >> .env; cat <<< x',
    'diff <(true) <(true); echo A=1 >> .env',
    'echo A=1 >> .env; tee >(cat) < /dev/null',
    'echo A=1 > >(cat >> .env)',
  ], false);
});

test('redefinition class writer by path or variable: /bin/echo, ./echo, ~/x/echo, $E and ${E} refuse the write', async (t) => {
  await refuseAll(t, [
    '/bin/echo A=1 >> .env',
    './echo A=1 >> .env',
    '~/x/echo A=1 >> .env',
    'E=echo; $E A=1 >> .env',
    'E=echo; ${E} A=1 >> .env',
    'E=printf; $E A=1 > .env',
  ], false);
});

test('redefinition class writer behind a wrapper: only the exact two-word builtin and command forms pass', async (t) => {
  await refuseAll(t, [
    'env echo A=1 >> .env',
    'command builtin echo A=1 >> .env',
    'command -p echo A=1 >> .env',
    'command command echo A=1 >> .env',
    'builtin builtin echo A=1 >> .env',
    "builtin printf '%s' A=1 >> .env",
    'builtin echo -n A=1 >> .env',
    'sudo echo A=1 >> .env',
    'X=1 echo A=1 >> .env',
  ], false);
  const dir = project(t);
  for (const command of ['builtin echo A=1 >> .env', "command printf 'A=1' >> .env", "builtin printf 'A=1' > .env", 'command echo A=1 >> .env']) {
    for (const d of await both(dir, command)) assert.notEqual(d.decision, 'deny', command + ' ' + JSON.stringify(d));
  }
  const isEnv = (x) => /(^|[\\/])\.env$/.test(x);
  assert.equal(loaderEnv.shellDotenvWrite('builtin echo LD_PRELOAD=x >> .env', isEnv).verdict, 'LD_PRELOAD');
});

test('redefinition rule leaves plain literal writes and single-quoted text alone', async (t) => {
  const dir = project(t);
  const fine = [
    'echo A=1 >> .env',
    'true && echo A=1 >> .env',
    'echo ENV=prod >> .env',
    "echo 'NOTE=alias and source' >> .env",
    "echo 'NOTE=functions()' >> .env",
    "echo 'NOTE=<(x)' >> .env",
  ];
  const isEnv = (x) => /(^|[\\/])\.env$/.test(x);
  for (const command of fine) {
    assert.equal(loaderEnv.shellDotenvWrite(command, isEnv).verdict, null, command);
    for (const d of await both(dir, command)) assert.notEqual(d.decision, 'deny', command + ' ' + JSON.stringify(d));
  }
  assert.equal(loaderEnv.shellDotenvWrite('echo() { :; }; echo A=1 >> .env', isEnv).verdict, loaderEnv.REDEFINABLE);
  assert.equal(loaderEnv.shellDotenvWrite('echo "a\'b"; echo A=1 >> .env', isEnv).verdict, null);
  assert.ok(loaderEnv.shellDotenvWrite("echo 'x; echo A=1 >> .env", isEnv).verdict);
  // Double-quoted text is read (it can hold expansions), so a keyword inside it refuses.
  assert.equal(loaderEnv.shellDotenvWrite('echo "NOTE=eval later" >> .env', isEnv).verdict, loaderEnv.REDEFINABLE);
});

test('redefinition class shadowed writers: a function, alias, path or variable for echo, printf or cat refuses the write', async (t) => {
  const here = (w) => w + " <<'EOF' > .env\nA=1\nEOF";
  await refuseAll(t, [
    'echo() { :; }; echo A=1 > .env',
    "printf() { :; }; printf 'A=1' > .env",
    'cat() { :; }; ' + here('cat'),
    'function cat { :; }; ' + here('cat'),
    'alias echo=printf; echo A=1 > .env',
    "alias printf=echo; printf 'A=1' > .env",
    'alias cat=tee; ' + here('cat'),
    here('cat') + '\nalias cat=tee',
    'unalias cat; ' + here('cat'),
    here('/bin/cat'),
    here('./cat'),
    here('~/x/cat'),
    'C=cat; ' + here('$C'),
    'C=cat; ' + here('${C}'),
    here('command cat'),
    here('builtin cat'),
    here('env cat'),
  ], false);
  const dir = project(t);
  for (const d of await both(dir, here('cat'))) assert.notEqual(d.decision, 'deny', JSON.stringify(d));
});
