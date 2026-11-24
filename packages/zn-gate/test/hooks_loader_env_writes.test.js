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
const loaderEnv = require('../lib/loader-env');
const { classifyEnv } = require('../lib/audit/patterns');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const STOP = /would set (LD_TRACE_LOADED_OBJECTS|LD_DEBUG) for the agent/;

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

const blocked = (d, re, what) => { assert.equal(d.decision, "deny", JSON.stringify(d) + " " + (what || "")); if (re) assert.match(d.message, re); };
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
});

test('shell commands that write a .env without those variables, or write elsewhere, pass', async (t) => {
  const dir = project(t);
  const fine = [
    'echo DEBUG=1 >> .env',
    'echo LD_DEBUG=all >> .env',
    "printf 'LD_LIBRARY_PATH=/opt/lib\\n' >> .env",
    'echo LD_DEBUG=help > notes.txt',
    'LD_DEBUG=libs ls',
    "sed -i 's/^DEBUG=.*/DEBUG=0/' .env",
  ];
  for (const command of fine) {
    passes(await decide(claude, cc('Bash', { command }, dir)));
    passes(await decide(gemini, gem('run_shell_command', { command }, dir)));
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

test('shell commands that write a .env with a computed loader value are blocked, a plain literal passes', async (t) => {
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
  for (const command of ['echo LD_DEBUG=libs >> .env', "echo 'LD_DEBUG=all' >> .env", 'echo LD_DEBUG=$V > notes.txt', 'echo LD_DEBUG= >> .env']) {
    passes(await decide(claude, cc('Bash', { command }, dir)));
  }
});
