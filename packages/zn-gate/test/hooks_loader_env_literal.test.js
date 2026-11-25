'use strict';
// Policy changed (2026-11-25): a shell command may not write a .env the agent loads (Gemini CLI reads the project .env and
// .gemini/.env), whatever it writes. The shell can run a different echo, printf or cat than the command shows (an inherited function,
// an alias or function from an earlier command of a persistent shell, an untrusted PATH), so a "literal" write cannot be proved from
// the command. The agent edits the file with the editor tool, which zn checks on the real text. Fixtures are inert.

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

const OPAQUE = /Edit \.env with the file editor tool; shell writes to \.env files are blocked\. zn cannot see what the shell actually writes\./;
const NAMED = /would set (LD_DEBUG|LD_TRACE_LOADED_OBJECTS|LD_PRELOAD) for the agent/;
const REFUSED = /shell writes to \.env files are blocked|would set (LD_DEBUG|LD_TRACE_LOADED_OBJECTS|LD_PRELOAD)/;

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

// Each command must be refused on both adapters.
async function refuseAll(t, commands, message = REFUSED) {
  const dir = project(t);
  for (const command of commands) {
    for (const d of await both(dir, command)) {
      assert.equal(d.decision, 'deny', command);
      assert.match(d.message, message, command);
    }
  }
}

test('former literal echo, printf and quoted here-document writes to a .env are now refused; touch .env still passes', async (t) => {
  // Policy changed (2026-11-25): these used to pass as literal writes.
  await refuseAll(t, [
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
  ]);
  const dir = project(t);
  for (const d of await both(dir, 'touch .env')) assert.notEqual(d.decision, 'deny', JSON.stringify(d));
  for (const d of await both(dir, 'echo A=1 >> notes.txt')) assert.notEqual(d.decision, 'deny', JSON.stringify(d));
});

test('inherited writer override: even a plain echo to a .env is refused, since the hook cannot see an inherited function', async (t) => {
  // A function or alias for echo defined by an earlier command of a persistent shell, or inherited from the environment, is invisible
  // to the hook: the command below looks like a plain literal write and is refused for that reason.
  await refuseAll(t, ['echo A=1 >> .env', 'echo A=1 > .gemini/.env'], OPAQUE);
});

test('the editor tool still writes a .env: Write and Edit of A=1 are not refused', async (t) => {
  const dir = project(t);
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'B=2\n');
  const write = { session_id: 's', cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'A=1\n' }, tool_use_id: 't' };
  const edit = { session_id: 's', cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'B=2', new_string: 'A=1' }, tool_use_id: 't' };
  for (const raw of [write, edit]) {
    const d = await decide(claude, raw);
    assert.notEqual(d.decision, 'deny', JSON.stringify(d));
  }
  // The editor tool is checked on the real text: a loader variable is still refused there.
  const bad = Object.assign({}, write, { tool_input: { file_path: file, content: 'LD_DEBUG=help\n' } });
  assert.equal((await decide(claude, bad)).decision, 'deny');
});

test('printf with a format, behind a wrapper or prefix, or quoted as a word is refused', async (t) => {
  await refuseAll(t, [
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
  ], /shell writes to \.env files are blocked|would set LD_DEBUG for the agent/);
});

test('expansions, substitutions, globs, echo options and multi-line arguments are refused', async (t) => {
  await refuseAll(t, [
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
  ], /shell writes to \.env files are blocked|would set LD_DEBUG for the agent/);
});

test('copies, other writers and here-documents are refused: zn cannot see what they write', async (t) => {
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
  for (const command of ["Set-Content .env 'A=1'", "Add-Content -Path .env -Value 'A=1'", "'A=1' | Out-File .env"]) {
    const d = await decide(claude, { session_id: 's', cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command }, tool_use_id: 't' });
    assert.equal(d.decision, 'deny', command);
    assert.match(d.message, OPAQUE, command);
  }
});

test('writes that set a loader variable keep their own refusal', async (t) => {
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

test('shellDotenvWrite refuses any redirection to a dotenv file and none to other files', () => {
  const isEnv = (x) => /(^|[\\/])\.env$/.test(x);
  assert.equal(loaderEnv.shellDotenvWrite('echo A=1 > .env; echo B=2 >> sub/.env', isEnv).verdict, loaderEnv.OPAQUE_WRITE);
  assert.equal(loaderEnv.shellDotenvWrite('echo A=1 > notes.txt', isEnv).verdict, null);
  assert.equal(loaderEnv.shellDotenvWrite('echo A=1 >> .env', isEnv).verdict, loaderEnv.OPAQUE_WRITE);
  assert.equal(loaderEnv.shellDotenvWrite('echo LD_PRELOAD=x >> .env', isEnv).verdict, 'LD_PRELOAD');
});

// Policy changed (2026-11-25): the classes below used to be refused only when the same command could redefine its writer. Every shell
// write to a dotenv file is refused now; each class keeps a test that asserts the refusal.

test('redefinition class function: a function definition anywhere in the command refuses the dotenv write', async (t) => {
  await refuseAll(t, [
    "echo() { printf 'LD_PRELOAD=x\\n'; }; echo A=1 >> .env",
    'echo() { :; }; echo A=1 >> .env',
    'echo () { :; }; echo A=1 >> .env',
    'function echo { :; }; echo A=1 > .env',
    'printf() { :; }; printf A=1 >> .env',
    'echo A=1 > .env; echo() { :; }',
  ]);
});

test('redefinition class alias: alias and unalias anywhere in the command refuse the dotenv write', async (t) => {
  await refuseAll(t, ['alias echo=printf; echo A=1 >> .env', 'unalias echo; echo A=1 >> .env', "cat <<'EOF' > .env\nA=1\nEOF\nalias cat=true"]);
});

test('redefinition class eval, source, dot and exec refuse the dotenv write', async (t) => {
  await refuseAll(t, [
    'eval true; echo A=1 > .env',
    'source ./x.sh; echo A=1 >> .env',
    '. ./x.sh && echo A=1 >> .env',
    'echo A=1 >> .env; . ./x.sh',
    'exec true; echo A=1 > .env',
  ]);
});

test('redefinition class builtin switches: enable, hash, declare, set -o, shopt, builtin refuse the write', async (t) => {
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
  ]);
});

test('redefinition class lookup variables: PATH, BASH_ENV and ENV assignments refuse the write', async (t) => {
  await refuseAll(t, [
    'export PATH=/tmp/bin; echo A=1 >> .env',
    'PATH=/tmp/bin; echo A=1 >> .env',
    'PATH+=:/tmp/bin; echo A=1 >> .env',
    'BASH_ENV=/tmp/x; echo A=1 > .env',
    'ENV=/tmp/x; echo A=1 > .env',
  ]);
});

test('redefinition class here-string and process substitution: <<<, <( ) and >( ) anywhere refuse the write', async (t) => {
  await refuseAll(t, [
    'cat <<< x; echo A=1 >> .env',
    'echo A=1 >> .env; cat <<< x',
    'diff <(true) <(true); echo A=1 >> .env',
    'echo A=1 >> .env; tee >(cat) < /dev/null',
    'echo A=1 > >(cat >> .env)',
  ]);
});

test('redefinition class writer by path or variable: /bin/echo, ./echo, ~/x/echo, $E and ${E} refuse the write', async (t) => {
  await refuseAll(t, [
    '/bin/echo A=1 >> .env',
    './echo A=1 >> .env',
    '~/x/echo A=1 >> .env',
    'E=echo; $E A=1 >> .env',
    'E=echo; ${E} A=1 >> .env',
    'E=printf; $E A=1 > .env',
  ]);
});

test('redefinition class writer behind a wrapper: every form refuses, the two-word builtin and command forms too', async (t) => {
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
    // Policy changed (2026-11-25): these two-word forms used to pass.
    'builtin echo A=1 >> .env',
    "command printf 'A=1' >> .env",
    "builtin printf 'A=1' > .env",
    'command echo A=1 >> .env',
  ]);
  const isEnv = (x) => /(^|[\\/])\.env$/.test(x);
  assert.equal(loaderEnv.shellDotenvWrite('builtin echo LD_PRELOAD=x >> .env', isEnv).verdict, 'LD_PRELOAD');
});

test('redefinition class plain text: single-quoted keywords in a write to a .env are refused; the same text written elsewhere passes', async (t) => {
  // Policy changed (2026-11-25): these used to pass as plain literal writes.
  await refuseAll(t, [
    'echo A=1 >> .env',
    'true && echo A=1 >> .env',
    'echo ENV=prod >> .env',
    "echo 'NOTE=alias and source' >> .env",
    "echo 'NOTE=functions()' >> .env",
    "echo 'NOTE=<(x)' >> .env",
    'echo "NOTE=eval later" >> .env',
    'echo "a\'b"; echo A=1 >> .env',
  ]);
  const isEnv = (x) => /(^|[\\/])\.env$/.test(x);
  // An unterminated quote is read quote-blind: the redirection is still found.
  assert.ok(loaderEnv.shellDotenvWrite("echo 'x; echo A=1 >> .env", isEnv).verdict);
  const dir = project(t);
  for (const command of ["echo 'NOTE=functions()' >> notes.txt", 'echo() { :; }; echo A=1 >> notes.txt']) {
    for (const d of await both(dir, command)) assert.notEqual(d.decision, 'deny', command + ' ' + JSON.stringify(d));
  }
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
    // Policy changed (2026-11-25): the plain cat here-document used to pass.
    here('cat'),
  ]);
});

test('two calls: a prior echo definition or sourced file cannot make a later shell write to .env pass', async (t) => {
  // Call 1 defines or loads a writer and names no dotenv file, so it gets whatever verdict it gets today; call 2 looks like a plain
  // literal write. A persistent shell would run call 2 with the redefined echo, so call 2 is refused on its own.
  const dir = project(t);
  for (const first of ["echo() { printf 'LD_PRELOAD=/tmp/x.so\n'; }", 'source ./defs.sh', '. ./defs.sh', 'alias echo=printf']) {
    await both(dir, first);
    for (const d of await both(dir, 'echo A=1 >> .env')) {
      assert.equal(d.decision, 'deny', first);
      assert.match(d.message, OPAQUE, first);
    }
  }
});
