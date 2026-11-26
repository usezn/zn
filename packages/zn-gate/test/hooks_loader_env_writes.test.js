'use strict';
// On Linux with glibc, LD_TRACE_LOADED_OBJECTS (any value) or LD_DEBUG naming "help" in the environment an agent gives its hooks
// makes the loader end every hook before its first line. Once it is set, no hook can refuse anything, so the hooks refuse the write
// that would set it: a project .env (Gemini CLI loads it) and .gemini/.env, and the agents' settings files. Fixtures are inert text.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runner = require('../lib/hooks/runner');
const claude = require('../lib/agents/claude-code');
const gemini = require('../lib/agents/gemini');
const codex = require('../lib/agents/codex');
const copilot = require('../lib/agents/copilot');
const loaderEnv = require('../lib/loader-env');
const { classifyEnv } = require('../lib/audit/patterns');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const STOP = /would set (LD_TRACE_LOADED_OBJECTS|LD_DEBUG) for the agent/;
// Every shell write to a watched .env is refused. A command that names a loader variable literally (even split by quotes, escapes or a
// variable set earlier in the same command) gets the specific STOP refusal. A command that does not (no loader name at all, or a name
// the shell builds with $N, ${N}, $(...), a glob, a brace or a \x or octal escape) gets the generic shell-write refusal: zn cannot say
// which variable it would set, so these are asserted as the generic message, listed here by exact command.
const SHELL_WRITE = {};
const GENERIC_SHELL_WRITE = /shell writes to \.env files are blocked/;
const GENERIC_SHELL_WRITES = new Set([
  "N=DEBUG; echo LD_$N=help >> .env",
  "echo \"${K}=help\" >> .env",
  "echo \"APP_DEBUG=$X\" >> .env",
  "echo \"FOO=1\" > .env",
  "echo $'\\x4cD_DEBUG=help' >> .env",
  "echo -e '\\x4cD_DEBUG=help' >> .env",
  "echo API_URL=$HOME/api >> .env",
  "echo DEBUG=1 >> .env",
  "echo L$(echo D)_DEBUG=help >> .env",
  "echo LD_${N}=help >> .env",
  "echo LD_DEBU?=help >> .env",
  "echo LD_{DEBUG,X}=help >> .env",
  "echo {LD,X}_DEBUG=help >> .env",
  "printf '%s=%s\\n' \"$K\" \"$V\" >> .env",
  "printf '%s_DEBUG=help\\n' LD >> .env",
  "printf 'LD_LIBRARY_PATH=/opt/lib' >> .env",
  "printf 'LD_LIBRARY_PATH=/opt/lib\\n' >> .env",
  "printf 'PORT=%s\\n' 8080 >> .env",
  "printf '\\114D_DEBUG=help\\n' >> .env",
  "printf '\\x4cD_DEBUG=help\\n' >> .env",
  "sed -i 's/^DEBUG=.*/DEBUG=0/' .env",
]);

function project(t) {
  const dir = tempDir(t, 'zn-ldwrite-');
  fs.mkdirSync(path.join(dir, '.gemini'), { recursive: true });
  return dir;
}

async function decide(adapter, raw) {
  const res = await runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
  return res.decision;
}

const cc = (tool_name, tool_input, cwd) => ({ session_id: 's', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't' });
const gem = (tool_name, tool_input, cwd) => ({ session_id: 's', cwd, hook_event_name: 'BeforeTool', tool_name, tool_input });
const cdx = (tool_name, tool_input, cwd) => ({ session_id: 's', cwd, hook_event_name: 'PreToolUse', tool_name, tool_input, turn_id: 'u', tool_use_id: 't' });
const patch = (kind, file, lines) => '*** Begin Patch\n*** ' + kind + ' File: ' + file + '\n' + (kind === 'Update' ? '@@\n' : '') + lines.map((l) => '+' + l).join('\n') + '\n*** End Patch\n';

const blocked = (d, re, what) => {
  assert.equal(d.decision, "deny", JSON.stringify(d) + " " + (what || ""));
  if (re === SHELL_WRITE) assert.match(d.message, GENERIC_SHELL_WRITES.has(what) ? GENERIC_SHELL_WRITE : STOP, what);
  else if (re) assert.match(d.message, re);
};
const passes = (d) => assert.notEqual(d.decision, 'deny', JSON.stringify(d));

test('hookStopAssignedIn agrees with the audit on which settings stop the hooks', () => {
  const pairs = [['LD_TRACE_LOADED_OBJECTS', '1'], ['LD_TRACE_LOADED_OBJECTS', ''], ['LD_DEBUG', 'help'], ['LD_DEBUG', 'libs,help'], ['LD_DEBUG', 'help:libs'],
    ['LD_DEBUG', 'all'], ['LD_DEBUG', 'libs'], ['LD_DEBUG', 'xhelp'], ['LD_DEBUG', 'HELP'], ['LD_PRELOAD', 'x.so'], ['LD_TRACE_LOADED_OBJECTS_FMT1', 'x'], ['DEBUG', 'help']];
  for (const [k, v] of pairs) {
    const audit = classifyEnv(k, v) && classifyEnv(k, v).kind === 'hookstop';
    const forms = [k + '=' + v, 'export ' + k + '="' + v + '"', "echo '" + k + '=' + v + "' >> .env", k + "='" + v + "'", '$env:' + k + "='" + v + "'"];
    for (const f of forms) assert.equal(loaderEnv.hookStopAssignedIn(f) !== null, !!audit, f);
  }
  assert.equal(loaderEnv.hookStopAssignedIn('# LD_DEBUG is not set here\nFOO=1'), null);
  assert.equal(loaderEnv.hookStopAssignedIn('MY_LD_DEBUG=help'), null);
});

test('Claude Code Write, Edit and MultiEdit of a .env that would set the variables are blocked', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  blocked(await decide(claude, cc('Write', { file_path: env, content: 'DEBUG=1\nLD_TRACE_LOADED_OBJECTS=1\n' }, dir)), STOP);
  blocked(await decide(claude, cc('Write', { file_path: env, content: 'export LD_DEBUG="libs,help"\n' }, dir)), STOP);
  blocked(await decide(claude, cc('Write', { file_path: path.join(dir, '.env.local'), content: 'LD_DEBUG=help\n' }, dir)), STOP);
  blocked(await decide(claude, cc('Edit', { file_path: env, old_string: 'DEBUG=1', new_string: 'LD_DEBUG=help' }, dir)), STOP);
  blocked(await decide(claude, cc('MultiEdit', { file_path: env, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'LD_TRACE_LOADED_OBJECTS=' }] }, dir)), STOP);
  // The edit changes only the value: judged on the file as it would be left.
  fs.writeFileSync(env, 'FOO=1\nLD_DEBUG=all\n');
  blocked(await decide(claude, cc('Edit', { file_path: env, old_string: 'LD_DEBUG=all', new_string: 'LD_DEBUG=help' }, dir)), STOP);
  blocked(await decide(claude, cc('Edit', { file_path: env, old_string: '=all', new_string: '=help' }, dir)), STOP);
});

test('Claude Code writes that do not set a variable that stops the hooks pass', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  passes(await decide(claude, cc('Write', { file_path: env, content: 'DEBUG=true\nPORT=3000\n' }, dir)));
  passes(await decide(claude, cc('Write', { file_path: env, content: 'LD_DEBUG=all\nLD_LIBRARY_PATH=/opt/lib\n' }, dir)));
  passes(await decide(claude, cc('Edit', { file_path: env, old_string: 'a', new_string: 'LD_DEBUG=libs' }, dir)));
  passes(await decide(claude, cc('Write', { file_path: path.join(dir, '.env.example'), content: 'LD_DEBUG=help\n' }, dir)));
  passes(await decide(claude, cc('Write', { file_path: path.join(dir, 'notes.txt'), content: 'LD_TRACE_LOADED_OBJECTS=1 stops the loader\n' }, dir)));
});

test('Claude Code settings files are refused whole, so a settings change that adds the variables is blocked', async (t) => {
  const dir = project(t);
  const body = JSON.stringify({ env: { LD_TRACE_LOADED_OBJECTS: '1' } });
  blocked(await decide(claude, cc('Write', { file_path: path.join(dir, '.claude', 'settings.json'), content: body }, dir)));
  blocked(await decide(claude, cc('Write', { file_path: path.join(dir, '.claude', 'settings.local.json'), content: body }, dir)));
  blocked(await decide(claude, cc('Edit', { file_path: path.join(dir, '.claude', 'settings.json'), old_string: '{}', new_string: body }, dir)));
});

test('Gemini CLI write_file and replace of .env and .gemini/.env that would set the variables are blocked', async (t) => {
  const dir = project(t);
  for (const rel of ['.env', '.gemini/.env']) {
    const file = path.join(dir, rel);
    blocked(await decide(gemini, gem('write_file', { file_path: file, content: 'KEY=1\nLD_TRACE_LOADED_OBJECTS=1\n' }, dir)), STOP);
    blocked(await decide(gemini, gem('write_file', { file_path: file, content: 'LD_DEBUG=help' }, dir)), STOP);
    blocked(await decide(gemini, gem('replace', { file_path: file, old_string: 'KEY=1', new_string: 'LD_DEBUG=libs,help', instruction: 'x' }, dir)), STOP);
    passes(await decide(gemini, gem('write_file', { file_path: file, content: 'KEY=1\nLD_DEBUG=all\n' }, dir)));
    passes(await decide(gemini, gem('replace', { file_path: file, old_string: 'KEY=1', new_string: 'KEY=2', instruction: 'x' }, dir)));
  }
  fs.writeFileSync(path.join(dir, '.env'), 'LD_DEBUG=all\n');
  blocked(await decide(gemini, gem('replace', { file_path: path.join(dir, '.env'), old_string: 'all', new_string: 'help', instruction: 'x' }, dir)), STOP);
});

test('Gemini CLI settings that set an env variable for the agent are refused whole', async (t) => {
  const dir = project(t);
  blocked(await decide(gemini, gem('write_file', { file_path: path.join(dir, '.gemini', 'settings.json'), content: '{"env":{"LD_TRACE_LOADED_OBJECTS":"1"}}' }, dir)));
  passes(await decide(gemini, gem('write_file', { file_path: path.join(dir, 'config.json'), content: '{"LD_TRACE_LOADED_OBJECTS":"1"}' }, dir)));
});

test('Codex CLI patches of .env that would set the variables are blocked, benign ones pass', async (t) => {
  const dir = project(t);
  blocked(await decide(codex, cdx('apply_patch', { command: patch('Add', '.env', ['LD_TRACE_LOADED_OBJECTS=1']) }, dir)), STOP);
  blocked(await decide(codex, cdx('apply_patch', { command: patch('Update', '.gemini/.env', ['X=1', 'LD_DEBUG=help']) }, dir)), STOP);
  passes(await decide(codex, cdx('apply_patch', { command: patch('Update', '.env', ['DEBUG=1', 'LD_DEBUG=all']) }, dir)));
  passes(await decide(codex, cdx('apply_patch', { command: patch('Add', 'src/a.txt', ['LD_TRACE_LOADED_OBJECTS=1']) }, dir)));
});

test('Codex CLI config that sets shell_environment_policy.set is refused whole', async (t) => {
  const dir = project(t);
  const toml = '[shell_environment_policy.set]\nLD_TRACE_LOADED_OBJECTS = "1"\n';
  blocked(await decide(codex, cdx('apply_patch', { command: patch('Add', '.codex/config.toml', toml.trimEnd().split('\n')) }, dir)));
  blocked(await decide(codex, cdx('Bash', { command: "printf '[shell_environment_policy.set]\\nLD_DEBUG = \"help\"\\n' >> .codex/config.toml" }, dir)));
});

test('shell commands that write a .env with the variables are blocked', async (t) => {
  const dir = project(t);
  const bad = [
    "echo 'LD_TRACE_LOADED_OBJECTS=1' >> .env",
    'echo LD_DEBUG=help > .env',
    'echo "LD_DEBUG=libs,help" >> .gemini/.env',
    "printf 'KEY=1\\nLD_TRACE_LOADED_OBJECTS=\\n' >> .env",
    "echo LD_DEBUG=help | tee -a .env",
    "sed -i 's/^DEBUG=.*/LD_DEBUG=help/' .env",
    "cat >> .env <<'EOF'\nLD_TRACE_LOADED_OBJECTS=1\nEOF",
    "cd sub && echo LD_DEBUG=help >> .env",
  ];
  for (const command of bad) {
    blocked(await decide(claude, cc("Bash", { command }, dir)), STOP, command);
    blocked(await decide(gemini, gem('run_shell_command', { command }, dir)), STOP);
  }
  blocked(await decide(claude, cc('PowerShell', { command: "Add-Content .env 'LD_TRACE_LOADED_OBJECTS=1'" }, dir)), STOP);
  // Set-Content replaces the file: the same refusal, with -Path, -Value and the sc alias too.
  for (const command of ["Set-Content .env 'LD_DEBUG=help'", "Set-Content -Path .env -Value 'LD_TRACE_LOADED_OBJECTS=1'", "sc .env 'LD_DEBUG=help'"]) {
    blocked(await decide(claude, cc('PowerShell', { command }, dir)), STOP, command);
  }
  // Policy changed (2026-11-25): Set-Content is not a literal echo or printf, so zn cannot check what it writes and refuses it, here
  // with the loader name the command holds. It used to pass with a harmless value.
  blocked(await decide(claude, cc('PowerShell', { command: "Set-Content .env 'LD_DEBUG=all'" }, dir)), STOP);
});

test('shell commands that write a .env without those variables, or write elsewhere, pass', async (t) => {
  const dir = project(t);
  const fine = [
    'echo LD_DEBUG=help > notes.txt',
    'LD_DEBUG=libs ls',
  ];
  for (const command of fine) {
    passes(await decide(claude, cc('Bash', { command }, dir)));
    passes(await decide(gemini, gem('run_shell_command', { command }, dir)));
  }
  // Policy changed (2026-11-25): no shell command may write a .env. These used to pass as literal echo or printf writes, or were
  // refused only for an in-place sed or a printf format; zn cannot check what the shell writes, so they are all refused now.
  for (const command of ['echo DEBUG=1 >> .env', 'echo LD_DEBUG=all >> .env', "printf 'LD_LIBRARY_PATH=/opt/lib' >> .env",
    "printf 'LD_LIBRARY_PATH=/opt/lib\\n' >> .env", "sed -i 's/^DEBUG=.*/DEBUG=0/' .env"]) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), SHELL_WRITE, command);
    blocked(await decide(gemini, gem('run_shell_command', { command }, dir)), SHELL_WRITE, command);
  }
});

test('a MultiEdit or camelCase edit that changes only a value is judged on the file it leaves', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'FOO=1\nLD_DEBUG=all\n');
  blocked(await decide(claude, cc('MultiEdit', { file_path: env, edits: [{ old_string: 'FOO=1', new_string: 'FOO=2' }, { old_string: '=all', new_string: '=help' }] }, dir)), STOP);
  // Applied in order: the second edit finds what the first one wrote.
  blocked(await decide(claude, cc('MultiEdit', { file_path: env, edits: [{ old_string: 'LD_DEBUG=all', new_string: 'LD_DEBUG=x' }, { old_string: '=x', new_string: '=help' }] }, dir)), STOP);
  blocked(await decide(claude, cc('MultiEdit', { file_path: env, edits: [{ oldString: '=all', newString: '=help' }] }, dir)), STOP);
  blocked(await decide(claude, cc('Edit', { file_path: env, oldString: '=all', newString: '=help' }, dir)), STOP);
  blocked(await decide(claude, cc('Edit', { file_path: env, old_string: 'all', new_string: 'help', replaceAll: true }, dir)), STOP);
  passes(await decide(claude, cc('MultiEdit', { file_path: env, edits: [{ old_string: 'FOO=1', new_string: 'FOO=2' }, { old_string: '=all', new_string: '=libs' }] }, dir)));
  passes(await decide(claude, cc('Edit', { file_path: env, oldString: 'FOO=1', newString: 'FOO=3' }, dir)));
});

test('an edit of a .env that cannot be resolved against the file is refused', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'FOO=1\nFOO=1\nLD_DEBUG=all\n');
  // The text to replace is not in the file, or is there twice without replace-all, or an edit has no new text.
  blocked(await decide(claude, cc('Edit', { file_path: env, old_string: 'MISSING', new_string: 'X=1' }, dir)));
  blocked(await decide(claude, cc('Edit', { file_path: env, old_string: 'FOO=1', new_string: 'FOO=2' }, dir)));
  blocked(await decide(claude, cc('MultiEdit', { file_path: env, edits: [{ old_string: 'LD_DEBUG=all', new_string: 'A=1' }, { old_string: 'LD_DEBUG=all', new_string: 'LD_DEBUG=help' }] }, dir)));
  blocked(await decide(claude, cc('MultiEdit', { file_path: env, edits: [{ old_string: '=all' }] }, dir)));
  // A .env that cannot be read (here a folder).
  const odd = path.join(dir, '.env.local');
  fs.mkdirSync(odd);
  blocked(await decide(claude, cc('Edit', { file_path: odd, old_string: 'a', new_string: 'b' }, dir)));
  // Other files are not guarded.
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x\n');
  passes(await decide(claude, cc('Edit', { file_path: path.join(dir, 'notes.txt'), old_string: 'nope', new_string: 'b' }, dir)));
});

test('shell commands that write a .env with a computed loader value are blocked, a literal one too', async (t) => {
  const dir = project(t);
  const bad = [
    'V=help; echo LD_DEBUG=$V >> .env',
    'echo "LD_DEBUG=${V}" >> .env',
    'echo LD_DEBUG=$(echo he)lp >> .env',
    'echo LD_DEBUG=`echo help` >> .env',
    'echo LD_DEBUG=$((1+1)) >> .env',
    "echo LD_DEBUG=he''lp >> .env",
    'echo LD_DEBUG=he\\lp >> .env',
    "printf 'LD_DEBUG=%s\\n' help >> .env",
    'echo LD_TRACE_LOADED_OBJECTS=$X >> .env',
  ];
  for (const command of bad) blocked(await decide(claude, cc('Bash', { command }, dir)), STOP, command);
  // Policy changed (2026-11-25): a literal value used to pass; only a write to another file does now.
  for (const command of ['echo LD_DEBUG=libs >> .env', "echo 'LD_DEBUG=all' >> .env", 'echo LD_DEBUG= >> .env']) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), SHELL_WRITE, command);
  }
  passes(await decide(claude, cc('Bash', { command: 'echo LD_DEBUG=$V > notes.txt' }, dir)));
});

test('shell writes that join quoted and unquoted pieces of a loader value are blocked', async (t) => {
  const dir = project(t);
  const bad = [
    'echo LD_DEBUG="he"lp >> .env',
    "echo LD_DEBUG='he'lp >> .env",
    'echo LD_DEBUG=he"lp" >> .env',
    "echo LD_DEBUG=he'lp' >> .env",
    `echo LD_DEBUG='he'"lp" >> .env`,
    `echo LD_DEBUG="he"'lp' >> .env`,
  ];
  for (const command of bad) blocked(await decide(claude, cc('Bash', { command }, dir)), STOP, command);
  // Policy changed (2026-11-25): a literal write used to be judged on the exact text it writes; every shell write to a .env is refused now.
  for (const command of ['echo LD_DEBUG="all" >> .env', "echo LD_DEBUG='all' >> .env", `echo 'LD_DEBUG="all"' >> .env`, `echo LD_DEBUG="a""b" >> .env`]) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), SHELL_WRITE, command);
  }
});

test('shell writes to a .env that build the loader name or hide it from the text are blocked', async (t) => {
  const dir = project(t);
  const bad = [
    // The name as a printf argument: the format writes NAME=value.
    "printf '%s=%s\\n' LD_DEBUG help > .env",
    "printf '%s=%s\\n' LD_TRACE_LOADED_OBJECTS 1 >> .env",
    'printf "%s=help\\n" LD_DEBUG >> .env',
    // The name split by quotes or a backslash.
    `echo 'LD_'"DEBUG"=help >> .env`,
    `echo "LD_""DEBUG=help" >> .env`,
    "echo L''D_DEBUG=help >> .env",
    'echo LD\\_DEBUG=help >> .env',
    // A name the shell or printf computes, or a piece of the name glued to an expansion.
    'K=LD_DEBUG; echo "$K=help" >> .env',
    'echo "${K}=help" >> .env',
    "printf '%s=%s\\n' \"$K\" \"$V\" >> .env",
    'N=DEBUG; echo LD_$N=help >> .env',
    'echo LD_${N}=help >> .env',
    'echo L$(echo D)_DEBUG=help >> .env',
    "printf '%s_DEBUG=help\\n' LD >> .env",
    // Brace expansion, a glob, and characters written by their code.
    'echo LD_{DEBUG,X}=help >> .env',
    'echo {LD,X}_DEBUG=help >> .env',
    'echo LD_DEBU?=help >> .env',
    "printf '\\x4cD_DEBUG=help\\n' >> .env",
    "printf '\\114D_DEBUG=help\\n' >> .env",
    "echo -e '\\x4cD_DEBUG=help' >> .env",
    "echo $'\\x4cD_DEBUG=help' >> .env",
  ];
  // The refusal names the loader variable when the command holds its name, and says the write cannot be checked otherwise.
  for (const command of bad) blocked(await decide(claude, cc('Bash', { command }, dir)), SHELL_WRITE, command);
  // A write to another file passes.
  passes(await decide(claude, cc('Bash', { command: "printf '%s=%s\\n' LD_DEBUG help > notes.txt" }, dir)));
  // Policy changed (2026-11-25): these used to pass as literal writes, or because only a value was expanded or formatted. No shell
  // write to a .env passes now.
  const nowRefused = [
    'echo LD_DEBUG=libs >> .env',
    "echo 'LD_DEBUG=all' >> .env",
    "printf 'LD_LIBRARY_PATH=/opt/lib' >> .env",
    'echo "FOO=1" > .env',
    "printf 'LD_LIBRARY_PATH=/opt/lib\\n' >> .env",
    'echo "APP_DEBUG=$X" >> .env',
    'echo API_URL=$HOME/api >> .env',
    "printf 'PORT=%s\\n' 8080 >> .env",
  ];
  for (const command of nowRefused) blocked(await decide(claude, cc('Bash', { command }, dir)), SHELL_WRITE, command);
});

test('an unquoted value is read as glibc reads it: a slash, bracket or backslash before ,help does not hide help', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  for (const v of ['x/,help', 'libs},help', 'a)\\,help', 'x\\,help', 'libs/x:help']) {
    assert.equal(loaderEnv.hookStopAssignedIn('LD_DEBUG=' + v + '\n'), 'LD_DEBUG', v);
    blocked(await decide(claude, cc('Write', { file_path: env, content: 'FOO=1\nLD_DEBUG=' + v + '\n' }, dir)), STOP, v);
    blocked(await decide(claude, cc('Bash', { command: 'echo LD_DEBUG=' + v + ' >> .env' }, dir)), STOP, v);
  }
  // A sed that writes the value still ends it at its slash: help there is the whole value.
  blocked(await decide(claude, cc('Bash', { command: "sed -i 's/^X=.*/LD_DEBUG=help/' .env" }, dir)), STOP);
  // Values without help stay allowed.
  for (const v of ['x/,libs', 'libs},all']) passes(await decide(claude, cc('Write', { file_path: env, content: 'LD_DEBUG=' + v + '\n' }, dir)));
});

test('the dotenv spellings NAME: value and back-quoted values are read like NAME=value', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  for (const line of ['LD_TRACE_LOADED_OBJECTS: 1', 'LD_DEBUG: help', 'LD_DEBUG:  libs,help', 'LD_DEBUG=`help`', 'LD_DEBUG: `help`', 'export LD_DEBUG: help']) {
    assert.ok(loaderEnv.hookStopAssignedIn(line + '\n'), line);
    blocked(await decide(claude, cc('Write', { file_path: env, content: 'FOO=1\n' + line + '\n' }, dir)), STOP, line);
    blocked(await decide(gemini, gem('write_file', { file_path: path.join(dir, '.gemini', '.env'), content: line + '\n' }, dir)), STOP, line);
  }
  fs.writeFileSync(env, 'FOO=1\nLD_DEBUG: all\n');
  blocked(await decide(claude, cc('Edit', { file_path: env, old_string: 'all', new_string: 'help' }, dir)), STOP);
  // No help, or no ": " (dotenv needs a space after the colon): allowed.
  for (const line of ['LD_DEBUG: libs', 'LD_DEBUG=`all`', 'LD_DEBUG:help']) {
    passes(await decide(claude, cc('Write', { file_path: env, content: line + '\n' }, dir)));
  }
  // In a shell command back quotes run a command: a back-quoted loader value is refused, whatever it holds.
  blocked(await decide(claude, cc('Bash', { command: "echo 'LD_DEBUG=`all`' >> .env" }, dir)), STOP);
  blocked(await decide(claude, cc('Bash', { command: "echo 'LD_DEBUG: help' >> .env" }, dir)), STOP);
});

test('GitHub Copilot CLI edits (old_str and new_str, arguments as a JSON text or an object) are judged on the file they leave', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'FOO=1\nLD_DEBUG=all\n');
  const copilot = require('../lib/agents').getAdapter('copilot');
  const pre = (toolArgs) => ({ sessionId: 's1', timestamp: 1792400000000, cwd: dir, toolName: 'edit', toolArgs });
  // A value-only edit: old all, new help. The text written alone does not name LD_DEBUG.
  blocked(await decide(copilot, pre(JSON.stringify({ path: env, old_str: 'all', new_str: 'help' }))), STOP);
  blocked(await decide(copilot, pre({ path: env, old_str: 'all', new_str: 'help' })), STOP);
  // The text searched for is not written: replacing LD_DEBUG=help elsewhere in the file is allowed.
  fs.writeFileSync(env, 'FOO=1\nLD_DEBUG=help\n');
  passes(await decide(copilot, pre(JSON.stringify({ path: env, old_str: 'LD_DEBUG=help', new_str: 'LD_DEBUG=all' }))));
});

test('an edit that removes or neutralises LD_DEBUG=help is allowed: the text it searches for is not written', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'FOO=1\nLD_DEBUG=help\n');
  passes(await decide(claude, cc('Edit', { file_path: env, old_string: 'LD_DEBUG=help', new_string: 'LD_DEBUG=all' }, dir)));
  passes(await decide(claude, cc('Edit', { file_path: env, old_string: 'LD_DEBUG=help\n', new_string: '' }, dir)));
  passes(await decide(claude, cc('Edit', { file_path: env, oldString: 'LD_DEBUG=help', newString: 'LD_DEBUG=all' }, dir)));
  passes(await decide(claude, cc('MultiEdit', { file_path: env, edits: [{ old_string: 'LD_DEBUG=help', new_string: 'LD_DEBUG=all' }] }, dir)));
  passes(await decide(claude, cc('MultiEdit', { file_path: env, edits: [{ old_string: 'LD_DEBUG=help\n', new_string: '' }, { old_string: 'FOO=1', new_string: 'FOO=2' }] }, dir)));
  // Still refused when the edit leaves the value in place.
  blocked(await decide(claude, cc('Edit', { file_path: env, old_string: 'FOO=1', new_string: 'FOO=2' }, dir)), STOP);
});

// Values that a regular expression might cut short: a slash, a bracket or a backslash before ",help". glibc reads the whole value,
// splits it at the comma and acts on "help", so each one must be refused in every write path.
const CUT_VALUES = ['x/,help', 'libs},help', 'libs),help', 'x\\,help', 'libs/x:help', 'all help'];

test('a loader value with a slash, bracket or backslash before ,help is refused in Write, Edit and patches', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  for (const v of CUT_VALUES) {
    blocked(await decide(claude, cc('Write', { file_path: env, content: 'PORT=1\nLD_DEBUG=' + v + '\n' }, dir)), STOP, v);
    blocked(await decide(claude, cc('Edit', { file_path: env, old_string: 'PORT=1', new_string: 'LD_DEBUG=' + v }, dir)), STOP, v);
    blocked(await decide(gemini, gem('write_file', { file_path: path.join(dir, '.gemini', '.env'), content: 'LD_DEBUG=' + v + '\n' }, dir)), STOP, v);
    blocked(await decide(codex, cdx('apply_patch', { command: patch('Add', '.env', ['LD_DEBUG=' + v]) }, dir)), STOP, v);
  }
  // The edit changes only the value: the file it leaves holds LD_DEBUG=x/,help.
  fs.writeFileSync(env, 'LD_DEBUG=all\n');
  blocked(await decide(claude, cc('Edit', { file_path: env, old_string: 'all', new_string: 'x/,help' }, dir)), STOP);
  // Other forms the dotenv package reads: a quoted value over two lines, NAME: value, backticks, export, an escape and a reference to
  // another variable.
  const dotenvForms = ['LD_DEBUG="all\n help"\n', 'LD_DEBUG: help\n', 'LD_TRACE_LOADED_OBJECTS: 1\n', 'LD_DEBUG=`help`\n',
    'LD_DEBUG=`libs,help`\n', 'export LD_DEBUG=x/,help\n', 'export LD_TRACE_LOADED_OBJECTS=1\n', 'LD_DEBUG="all\\n,help"\n', 'LD_DEBUG=${OPTS}\n',
    "LD_DEBUG='libs\n,help'\n"];
  for (const content of dotenvForms) {
    blocked(await decide(claude, cc('Write', { file_path: env, content }, dir)), STOP, content);
    blocked(await decide(gemini, gem('write_file', { file_path: path.join(dir, '.gemini', '.env'), content }, dir)), STOP, content);
    blocked(await decide(codex, cdx('apply_patch', { command: patch('Add', '.env', content.replace(/\n$/, '').split('\n')) }, dir)), STOP, content);
  }
  fs.writeFileSync(env, 'PORT=1\n');
  blocked(await decide(claude, cc('Edit', { file_path: env, old_string: 'PORT=1', new_string: 'LD_TRACE_LOADED_OBJECTS: 1' }, dir)), STOP);
  blocked(await decide(gemini, gem('replace', { file_path: env, old_string: 'PORT=1', new_string: 'LD_DEBUG=`help`', instruction: 'x' }, dir)), STOP);
  for (const content of ['LD_DEBUG: all\n', 'LD_DEBUG=`libs`\n']) passes(await decide(claude, cc('Write', { file_path: env, content }, dir)));
  for (const content of ['LD_DEBUG=all\n', 'LD_DEBUG=xhelp\nHELP_URL=https://example.com/help\n', 'LD_DEBUG=libs/x,files\n', 'LD_DEBUG=libs\nBAR=help\n']) {
    passes(await decide(claude, cc('Write', { file_path: env, content }, dir)));
  }
});

test('a shell write of a loader value with a slash, bracket or backslash before ,help is refused', async (t) => {
  const dir = project(t);
  for (const v of CUT_VALUES) {
    for (const command of ['echo LD_DEBUG=' + v + ' >> .env', "echo 'LD_DEBUG=" + v + "' >> .env", 'printf "LD_DEBUG=' + v + '\\n" >> .env',
      'cat >> .env <<EOF\nLD_DEBUG=' + v + '\nEOF']) {
      blocked(await decide(claude, cc('Bash', { command }, dir)), STOP, command);
      blocked(await decide(gemini, gem('run_shell_command', { command }, dir)), STOP, command);
    }
  }
  // The shell ends the word in another place than the text shows: a redirection glued to the value, a quoted piece after a space or a slash,
  // a quoted separator, a line break inside quotes.
  for (const command of ['echo LD_DEBUG=help>>.env', 'echo LD_DEBUG="all" help >> .env', 'echo LD_DEBUG=x/,"help" >> .env',
    'echo "LD_DEBUG=all;,help" >> .env', "echo 'LD_DEBUG=all\n,help' >> .env", 'echo LD_DEBUG: help >> .env']) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), STOP, command);
  }
  // Policy changed (2026-11-25): these two used to pass; every shell write to a .env is refused now.
  for (const command of ['echo LD_DEBUG=libs/x >> .env', 'echo LD_DEBUG=all >> .env']) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), SHELL_WRITE, command);
  }
  // Policy changed (2026-11-25): an in-place sed is not a literal echo or printf, so it is refused even with a harmless value.
  blocked(await decide(claude, cc('Bash', { command: "sed -i 's/LD_DEBUG=all/LD_DEBUG=libs/' .env" }, dir)), STOP);
});

test('the printf form and quoted pieces of the loader name are refused for a .env', async (t) => {
  const dir = project(t);
  const bad = [
    "printf '%s=%s' LD_DEBUG help >> .env",
    'printf "%s=%s\\n" "LD_DEBUG" "help" >> .env',
    'echo "LD_"DEBUG=help >> .env',
    'echo LD_"DEB"UG=help >> .env',
    "echo 'LD_DEB'UG=help >> .env",
    'K=LD_DEBUG; echo $K=help >> .env',
    'K=LD_DEBUG; printf "%s=help" "$K" >> .env',
  ];
  for (const command of bad) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), SHELL_WRITE, command);
    blocked(await decide(gemini, gem('run_shell_command', { command }, dir)), SHELL_WRITE, command);
  }
});

test('GitHub Copilot CLI edits of a .env: unreadable edits are refused, other files and benign values pass', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'FOO=1\nLD_DEBUG=all\n');
  const cop = (toolName, args) => ({ sessionId: 's1', timestamp: 1792400000000, cwd: dir, toolName, toolArgs: typeof args === 'string' ? args : JSON.stringify(args) });
  blocked(await decide(copilot, cop('edit', { path: env, old_str: 'all', new_str: 'help' })), STOP);
  blocked(await decide(copilot, cop('edit', { path: env, old_string: '=all', new_string: '=help' })), STOP);
  blocked(await decide(copilot, cop('edit', { path: env, old_str: 'all', new_str: 'x/,help' })), STOP);
  // The same edit with the arguments as an object.
  blocked(await decide(copilot, { sessionId: 's1', timestamp: 1792400000000, cwd: dir, toolName: 'edit', toolArgs: { path: env, old_str: 'all', new_str: 'help' } }), STOP);
  // An edit whose text is not in the file cannot be judged: refused for a .env.
  blocked(await decide(copilot, cop('edit', { path: env, old_str: 'MISSING', new_str: 'help' })));
  passes(await decide(copilot, cop('edit', { path: env, old_str: 'all', new_str: 'libs' })));
  passes(await decide(copilot, cop('edit', { path: env, old_str: 'FOO=1', new_str: 'FOO=2' })));
  // Other files are not guarded.
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'LD_DEBUG=all\n');
  passes(await decide(copilot, cop('edit', { path: path.join(dir, 'notes.txt'), old_str: 'all', new_str: 'help' })));
});

test('an edit never reads a target that is not a regular file: a FIFO or /dev/zero cannot hang the hook', { skip: process.platform === 'win32' }, async (t) => {
  const { execFileSync } = require('child_process');
  const dir = project(t);
  const fifo = path.join(dir, 'pipe.txt');
  execFileSync('mkfifo', [fifo]);
  // A path that is not a dotenv file is never opened.
  let t0 = Date.now();
  passes(await decide(claude, cc('Edit', { file_path: fifo, old_string: 'a', new_string: 'b' }, dir)));
  assert.ok(Date.now() - t0 < 5000);
  // A guarded .env that is a FIFO is refused as unresolved, without blocking.
  const env = path.join(dir, '.env');
  execFileSync('mkfifo', [env]);
  t0 = Date.now();
  blocked(await decide(claude, cc('Edit', { file_path: env, old_string: 'a', new_string: 'b' }, dir)));
  assert.ok(Date.now() - t0 < 5000);
  fs.unlinkSync(env);
  // A .env that links to /dev/zero is refused too.
  fs.symlinkSync('/dev/zero', env);
  t0 = Date.now();
  blocked(await decide(claude, cc('Edit', { file_path: env, old_string: 'a', new_string: 'b' }, dir)));
  assert.ok(Date.now() - t0 < 5000);
  fs.unlinkSync(env);
  // A normal .env with a benign value still passes.
  fs.writeFileSync(env, 'FOO=1\n');
  passes(await decide(claude, cc('Edit', { file_path: env, old_string: 'FOO=1', new_string: 'FOO=2' }, dir)));
});

// dotenv reads a quoted value with (?:\\Q|[^Q])*: a backslash before the quote character keeps the value open, in double quotes, single
// quotes and backticks, so these values still carry "help" for the loader. An unterminated quote is unresolved and refused.
test('an escaped quote does not end an LD_DEBUG value in a .env write (dotenv rules)', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  const bad = [String.raw`LD_DEBUG="all\",help"`, String.raw`LD_DEBUG='all\',help'`, 'LD_DEBUG=`all\\`,help`', String.raw`export LD_DEBUG="a\\\",help"`,
    'LD_DEBUG="all,help', "LD_DEBUG='all", 'LD_DEBUG="all'];
  for (const line of bad) {
    assert.notEqual(loaderEnv.hookStopAssignedIn(line + '\n'), null, line);
    blocked(await decide(claude, cc('Write', { file_path: env, content: 'FOO=1\n' + line + '\n' }, dir)), STOP, line);
    blocked(await decide(gemini, gem('write_file', { file_path: env, content: line + '\n' }, dir)), STOP, line);
    blocked(await decide(codex, cdx('apply_patch', { command: patch('Add', '.env', [line]) }, dir)), STOP, line);
  }
  // A value-only edit that leaves the escaped form behind.
  fs.writeFileSync(env, String.raw`LD_DEBUG="all\"X"` + '\n');
  blocked(await decide(claude, cc('Edit', { file_path: env, old_string: 'X', new_string: ',help' }, dir)), STOP);
  blocked(await decide(gemini, gem('replace', { file_path: env, old_string: 'X', new_string: ',help', instruction: 'x' }, dir)), STOP);
  // A benign value with an escaped quote and no help still passes.
  const ok = [String.raw`LD_DEBUG="a\"b"`, String.raw`LD_DEBUG='a\'b'`, 'LD_DEBUG="all"'];
  for (const line of ok) {
    assert.equal(loaderEnv.hookStopAssignedIn(line + '\n'), null, line);
    passes(await decide(claude, cc('Write', { file_path: env, content: line + '\n' }, dir)));
    passes(await decide(gemini, gem('write_file', { file_path: env, content: line + '\n' }, dir)));
    passes(await decide(codex, cdx('apply_patch', { command: patch('Add', '.env', [line]) }, dir)));
  }
  fs.writeFileSync(env, String.raw`LD_DEBUG="a\"X"` + '\n');
  passes(await decide(claude, cc('Edit', { file_path: env, old_string: 'X', new_string: 'b' }, dir)));
});

test('GitHub Copilot CLI: an unknown file tool with the .env path deep in its arguments is refused when the text next to it cannot be read', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'FOO=1');
  const other = path.join(dir, 'notes.txt');
  const cop = (args) => ({ sessionId: 's1', timestamp: 1792400000000, cwd: dir, toolName: 'files_helper', toolArgs: JSON.stringify(args) });
  const nest = (levels, leaf) => levels.reduceRight((acc, k) => ({ [k]: acc }), leaf);
  const { MAX_NEST_DEPTH } = require('../lib/nest-limits');
  assert.equal(copilot.MAX_NEST_DEPTH, MAX_NEST_DEPTH);
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  for (const target of [env, other]) {
    const dotenv = target === env;
    for (let levels = 1; levels <= MAX_NEST_DEPTH; levels++) {
      // The path and its content at the same level, from near the top to past the limit.
      const same = cop(nest(names.slice(0, levels), { path: target, content: 'LD_DEBUG=help' }));
      // The content one level below the path: the hooks read the arguments inside a wrapper, so past the limit the text is unknown and a dotenv target is refused.
      const below = cop(nest(names.slice(0, levels), { path: target, extra: { content: 'LD_DEBUG=help' } }));
      if (dotenv) blocked(await decide(copilot, same), levels === 1 ? STOP : null, 'same level ' + levels);
      else passes(await decide(copilot, same));
      const d = await decide(copilot, below);
      const out = (await runner.handle(copilot, below, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open' })).output;
      const outDeny = Boolean(out && out.permissionDecision === 'deny');
      // Where the refusal shows up: inside the limit the decision reads the nested text and denies it (a dotenv target only), and the
      // adapter answer (respond) echoes it; at the limit the text is unreadable, so the decision allows and only the adapter answer
      // (respond) refuses, for any target.
      if (levels < MAX_NEST_DEPTH) {
        if (dotenv) { blocked(d, null, 'below ' + levels); assert.equal(outDeny, true, 'below ' + levels + ' answer'); }
        else { passes(d); assert.equal(outDeny, false, 'below ' + levels + ' other'); }
      } else {
        // What the agent receives is the answer of the adapter: it must refuse (fail closed), whatever the decision says.
        assert.equal(outDeny, true, 'below ' + levels + ' answer');
        assert.match(String(out.permissionDecisionReason), /could not read/, 'below ' + levels + ' reason');
      }
    }
  }
});

// An unknown tool of Claude Code: the path scan reads as deep as the text scan (MAX_NEST_DEPTH). A .env path in the arguments is
// found at every level within the limit, and arguments nested past it cannot be read, so the call is refused (fail closed).
test('Claude Code: an unknown tool with a .env path deep in its arguments is refused, past the depth limit too', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'FOO=1');
  const other = path.join(dir, 'notes.txt');
  const nest = (levels, leaf) => levels.reduceRight((acc, k) => ({ [k]: acc }), leaf);
  const { MAX_NEST_DEPTH } = require('../lib/nest-limits');
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const call = (levels, target) => cc('files_helper', nest(names.slice(0, levels), { path: target, content: 'LD_DEBUG=help' }), dir);
  for (const levels of [1, 3, 4, 5, MAX_NEST_DEPTH]) {
    blocked(await decide(claude, call(levels, env)), null, 'env at ' + levels);
    passes(await decide(claude, call(levels, other)));
  }
  // Past the limit the path cannot be read: refused, for any target.
  for (const levels of [MAX_NEST_DEPTH + 1, MAX_NEST_DEPTH + 2]) {
    blocked(await decide(claude, call(levels, env)), null, 'env at ' + levels);
    blocked(await decide(claude, call(levels, other)), null, 'other at ' + levels);
  }
  // The same through a list of objects.
  const inList = (levels, target) => cc('files_helper', nest(names.slice(0, levels), { items: [{ path: target, content: 'LD_DEBUG=help' }] }), dir);
  blocked(await decide(claude, inList(MAX_NEST_DEPTH - 1, env)), null, 'list');
  passes(await decide(claude, inList(MAX_NEST_DEPTH - 1, other)));
  blocked(await decide(claude, inList(MAX_NEST_DEPTH, env)), null, 'list past the limit');
});

// An unknown tool, and the file tools with a nested path, of Gemini CLI and Antigravity: the path scan reads as deep as the text scan
// (MAX_NEST_DEPTH), and arguments nested past it cannot be read, so the call is refused (fail closed).
test('Gemini CLI and Antigravity: a .env path deep in the arguments is refused, past the depth limit too', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'FOO=1');
  const other = path.join(dir, 'notes.txt');
  const antigravity = require('../lib/agents/antigravity');
  const ag = (name, args) => ({ conversationId: 'c1', workspacePaths: [dir], toolCall: { name, args } });
  const nest = (levels, leaf) => levels.reduceRight((acc, k) => ({ [k]: acc }), leaf);
  const { MAX_NEST_DEPTH } = require('../lib/nest-limits');
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  // These adapters refuse an unreadable call in their own answer (respond), not in the decision: look at both.
  const answer = async (adapter, raw) => {
    const res = await runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
    return res.decision.decision === 'deny' || Boolean(res.output && res.output.decision === 'deny');
  };
  const refused = async (adapter, raw, what) => assert.equal(await answer(adapter, raw), true, what);
  const allowed = async (adapter, raw, what) => assert.equal(await answer(adapter, raw), false, what);
  const shapes = {
    gemini: (name, args) => gem(name, args, dir),
    antigravity: (name, args) => ag(name, args),
  };
  const adapters = { gemini, antigravity };
  const tools = { gemini: ['files_helper', 'write_file', 'replace'], antigravity: ['files_helper', 'write_file', 'replace_file_content'] };
  for (const id of ['gemini', 'antigravity']) {
    const adapter = adapters[id];
    for (const tool of tools[id]) {
      const w = id + ' ' + tool;
      const call = (levels, target) => shapes[id](tool, nest(names.slice(0, levels), { path: target, content: 'LD_DEBUG=help' }));
      for (const levels of [1, 3, 4, 5, MAX_NEST_DEPTH]) {
        await refused(adapter, call(levels, env), w + ' env at ' + levels);
        await allowed(adapter, call(levels, other), w + ' other at ' + levels);
      }
      // Past the limit the path cannot be read: refused, for any target.
      for (const levels of [MAX_NEST_DEPTH + 1, MAX_NEST_DEPTH + 2]) {
        await refused(adapter, call(levels, env), w + ' env at ' + levels);
        await refused(adapter, call(levels, other), w + ' other at ' + levels);
      }
      // The same through a list of objects.
      const inList = (levels, target) => shapes[id](tool, nest(names.slice(0, levels), { items: [{ path: target, content: 'LD_DEBUG=help' }] }));
      await refused(adapter, inList(MAX_NEST_DEPTH - 1, env), w + ' list');
      await allowed(adapter, inList(MAX_NEST_DEPTH - 1, other), w + ' list other');
      await refused(adapter, inList(MAX_NEST_DEPTH, env), w + ' list past the limit');
    }
  }
  // The scan itself: the depth limit and the node limit set `bad`.
  for (const a of [gemini, antigravity]) {
    assert.equal(a.pathsOf(nest(names.slice(0, MAX_NEST_DEPTH), { path: other })).bad, false);
    assert.equal(a.pathsOf(nest(names.slice(0, MAX_NEST_DEPTH + 1), { path: other })).bad, true);
    assert.equal(a.pathsOf({ items: [nest(names.slice(0, MAX_NEST_DEPTH), { x: 1 })] }).bad, true);
    assert.equal(a.pathsOf({ items: Array.from({ length: 600 }, () => ({ k: 1 })) }).bad, true);
  }
});
