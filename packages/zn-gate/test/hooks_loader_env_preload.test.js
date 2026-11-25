'use strict';
// A .env file the agent loads (Gemini CLI reads the project .env and .gemini/.env) that sets LD_PRELOAD, LD_AUDIT, DYLD_INSERT_LIBRARIES
// or another preload variable to a value loads a library into the shell of every hook before the hook runs, so the hooks refuse that write.
// A shell write whose variable names, or whole lines, only the shell knows once it runs is refused too. Fixtures are inert text: the
// paths name no real library.

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
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');
const { assertLinear } = require('./helpers/time_ratio');

const PRELOAD = (name) => new RegExp('would set ' + name + ' for the agent\\. That makes the dynamic loader load a library');
const ANY_PRELOAD = /would set [A-Z0-9_]+ for the agent\. That makes the dynamic loader load a library/;
const OPAQUE = /only the shell knows once it runs/;

function project(t) {
  const dir = tempDir(t, 'zn-ldpreload-');
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

const blocked = (d, re, what) => { assert.equal(d.decision, 'deny', JSON.stringify(d) + ' ' + (what || '')); if (re) assert.match(d.message, re, what); };
const passes = (d, what) => assert.notEqual(d.decision, 'deny', JSON.stringify(d) + ' ' + (what || ''));

test('the refused names come from LOADER_PRELOAD: all of it but LD_DEBUG, and no library search path', () => {
  assert.deepEqual(loaderEnv.PRELOAD_WRITE_NAMES, loaderEnv.LOADER_PRELOAD.filter((n) => n !== 'LD_DEBUG'));
  assert.ok(!loaderEnv.LOADER_PRELOAD.includes('LD_LIBRARY_PATH'));
  for (const name of loaderEnv.PRELOAD_WRITE_NAMES) {
    assert.equal(loaderEnv.preloadAssignedIn(name + '=/tmp/x.so\n'), name);
    assert.equal(loaderEnv.preloadAssignedIn('FOO=1\n' + name + '=\n'), null, name + ' empty');
  }
  assert.equal(loaderEnv.preloadAssignedIn('LD_LIBRARY_PATH=/opt/lib\nLD_DEBUG=all\nMY_LD_PRELOAD=x\n'), null);
  assert.equal(loaderEnv.preloadAssignedIn('LD_PRELOAD=""\nLD_AUDIT=\'\'\n'), null);
  assert.equal(loaderEnv.preloadAssignedIn('LD_PRELOAD="\n/tmp/x.so"\n'), 'LD_PRELOAD');
  assert.equal(loaderEnv.preloadAssignedIn('LD_PRELOAD="/tmp/x.so\n'), 'LD_PRELOAD');
  assert.equal(loaderEnv.preloadAssignedIn('A=1\\nLD_PRELOAD=/tmp/x.so'), 'LD_PRELOAD');
});

test('Claude Code Write, Edit and MultiEdit of a .env that sets a preload variable to a value are blocked', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  for (const [content, name] of [['LD_PRELOAD=/tmp/x.so\n', 'LD_PRELOAD'], ['FOO=1\nexport LD_AUDIT=x\n', 'LD_AUDIT'],
    ['DYLD_INSERT_LIBRARIES: y\n', 'DYLD_INSERT_LIBRARIES'], ["LD_PRELOAD='/tmp/x.so'\n", 'LD_PRELOAD'], ['LD_DEBUG_OUTPUT=/tmp/log\n', 'LD_DEBUG_OUTPUT']]) {
    blocked(await decide(claude, cc('Write', { file_path: env, content }, dir)), PRELOAD(name), content);
  }
  fs.writeFileSync(env, 'FOO=1\nLD_PRELOAD=\n');
  blocked(await decide(claude, cc('Edit', { file_path: env, old_string: 'LD_PRELOAD=', new_string: 'LD_PRELOAD=/tmp/x.so' }, dir)), PRELOAD('LD_PRELOAD'));
  blocked(await decide(claude, cc('MultiEdit', { file_path: env, edits: [{ old_string: 'FOO=1', new_string: 'export LD_AUDIT=x' }] }, dir)), PRELOAD('LD_AUDIT'));
  // An empty value loads nothing, and a library search path is not a preload: both keep today's verdict.
  passes(await decide(claude, cc('Write', { file_path: env, content: 'FOO=1\nLD_PRELOAD=\n' }, dir)));
  passes(await decide(claude, cc('Write', { file_path: env, content: 'LD_LIBRARY_PATH=/opt/lib\nLD_DEBUG=all\n' }, dir)));
  // A file that is not loaded into the agent's environment is not judged.
  passes(await decide(claude, cc('Write', { file_path: path.join(dir, 'notes.txt'), content: 'LD_PRELOAD=/tmp/x.so\n' }, dir)));
});

test('Gemini CLI write_file and Codex CLI patches of a .env that set a preload variable are blocked', async (t) => {
  const dir = project(t);
  for (const file of [path.join(dir, '.env'), path.join(dir, '.gemini', '.env')]) {
    blocked(await decide(gemini, gem('write_file', { file_path: file, content: 'KEY=1\nLD_PRELOAD=/tmp/x.so\n' }, dir)), PRELOAD('LD_PRELOAD'));
    blocked(await decide(gemini, gem('write_file', { file_path: file, content: 'DYLD_INSERT_LIBRARIES: y\n' }, dir)), PRELOAD('DYLD_INSERT_LIBRARIES'));
    passes(await decide(gemini, gem('write_file', { file_path: file, content: 'KEY=1\nLD_PRELOAD=\n' }, dir)));
  }
  blocked(await decide(codex, cdx('apply_patch', { command: patch('Add', '.env', ['DEBUG=1', 'LD_PRELOAD=/tmp/x.so']) }, dir)), PRELOAD('LD_PRELOAD'));
  blocked(await decide(codex, cdx('apply_patch', { command: patch('Add', '.env', ['export LD_AUDIT=x']) }, dir)), PRELOAD('LD_AUDIT'));
  passes(await decide(codex, cdx('apply_patch', { command: patch('Add', '.env', ['DEBUG=1', 'LD_LIBRARY_PATH=/opt/lib']) }, dir)));
});

test('shell writes of a preload variable with a value to a .env are blocked, an empty one passes', async (t) => {
  const dir = project(t);
  const bad = [
    ['echo LD_PRELOAD=/tmp/x.so >> .env', 'LD_PRELOAD'],
    ["echo 'export LD_AUDIT=x' >> .gemini/.env", 'LD_AUDIT'],
    ["printf 'DYLD_INSERT_LIBRARIES: y\\n' > .env", 'DYLD_INSERT_LIBRARIES'],
    ['echo LD_PRE"LOAD"=/tmp/x.so >> .env', 'LD_PRELOAD'],
    ['echo LD_PRELOAD= /tmp/x.so >> .env', 'LD_PRELOAD'],
    ["printf 'A=1\\nLD_PRELOAD=/tmp/x.so\\n' >> .env", 'LD_PRELOAD'],
  ];
  for (const [command, name] of bad) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), PRELOAD(name), command);
    blocked(await decide(gemini, gem('run_shell_command', { command }, dir)), PRELOAD(name), command);
  }
  blocked(await decide(claude, cc('PowerShell', { command: "Add-Content .env 'LD_PRELOAD=/tmp/x.so'" }, dir)), PRELOAD('LD_PRELOAD'));
  // The name as a printf argument, or glued to another word: refused whatever the value.
  blocked(await decide(claude, cc('Bash', { command: "printf '%s\\n' 'LD_PRELOAD=/tmp/x.so' > .env" }, dir)), ANY_PRELOAD);
  for (const command of ['echo LD_PRELOAD= >> .env', "echo 'LD_PRELOAD=' >> .env", 'echo LD_LIBRARY_PATH=/opt/lib >> .env', 'echo LD_PRELOAD=/tmp/x.so > notes.txt']) {
    passes(await decide(claude, cc('Bash', { command }, dir)), command);
  }
});

test('shell writes to a .env whose names or lines only the shell knows are blocked; literal names with expanded values pass', async (t) => {
  const dir = project(t);
  const bad = [
    'printf "$X" > .env',
    'echo "$LINE" >> .gemini/.env',
    'echo $LINE >> .env',
    "printf '%s\\n' \"$LINE\" >> .env",
    'echo "$(cat other.txt)" >> .env',
    'echo `cat other.txt` >> .env',
    'echo * > .env',
    'echo PRE{A,B}=1 >> .env',
    'cat > .env <<EOF\n$LINE\nEOF',
    "printf 'A=1\\n%s\\n' \"$LINE\" >> .env",
    'echo "A=1\\n$LINE" >> .env',
  ];
  for (const command of bad) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), OPAQUE, command);
    blocked(await decide(gemini, gem('run_shell_command', { command }, dir)), OPAQUE, command);
  }
  // A name computed right before "=": the computed-name refusal answers first; either way the write is refused.
  for (const command of ["printf '%s=%s\\n' \"$K\" \"$V\" > .env", 'echo "A_$N=1" >> .env']) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), /name the shell computes|only the shell knows once it runs/, command);
  }
  const good = [
    'echo "API_URL=$URL" >> .env',
    "printf 'TOKEN=%s\\n' \"$T\" >> .env",
    'printf "PORT=%s\\nHOST=%s\\n" "$P" "$H" > .env',
    'echo API_URL=$HOME/api >> .env',
    'export TOKEN=$(cat token.txt) && echo FOO=1 >> .env',
    "sed -i \"s|^TOKEN=.*|TOKEN=$T|\" .env",
    'echo "A=1" >> "$PWD/.env"',
    'cat > .env <<EOF\nAPI_URL=$URL\nexport TOKEN=$T\nEOF',
    "echo 'LITERAL=$NOT_EXPANDED' >> .env",
    'echo FOO=1 >> .env # $X',
    'cp .env.example .env',
    'cat template.txt > .env',
    '[ -f .env ] || echo FOO=1 > .env',
  ];
  for (const command of good) passes(await decide(claude, cc('Bash', { command }, dir)), command);
  // A literal name that is a loader name keeps its own refusal even with an expanded value.
  blocked(await decide(claude, cc('Bash', { command: 'echo "LD_PRELOAD=$LIB" >> .env' }, dir)), PRELOAD('LD_PRELOAD'));
  blocked(await decide(claude, cc('Bash', { command: 'echo "LD_DEBUG=$X" >> .env' }, dir)), /would set LD_DEBUG for the agent/);
});

test('copies from another file into a .env: a literal source passes as before, a source only the shell knows is refused', async (t) => {
  const dir = project(t);
  for (const command of ['cp other.env .env', 'cat other.env > .env', 'tee .env < other.env']) passes(await decide(claude, cc('Bash', { command }, dir)), command);
  for (const command of ['cp "$SRC" .env', 'cat "$SRC" > .env', 'cat *.env > .env']) blocked(await decide(claude, cc('Bash', { command }, dir)), OPAQUE, command);
});

test('the opaque-write scan is linear in the length of the command', () => {
  const build = (n) => 'echo ' + '"A=$X" '.repeat(n) + '"$Y" > .env';
  assertLinear((cmd) => loaderEnv.preloadOrOpaqueIn(cmd), build, 20000, 'many literal assignments before an opaque word');
  assert.equal(loaderEnv.preloadOrOpaqueIn(build(20000)), loaderEnv.OPAQUE_WRITE);
  const names = (n) => "printf '" + 'A_B_C\\n'.repeat(n) + "%s' \"$X\" > .env";
  assertLinear((cmd) => loaderEnv.preloadOrOpaqueIn(cmd), names, 15000, 'many names after escapes');
});
