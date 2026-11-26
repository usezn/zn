'use strict';
// A .env file the agent loads (Gemini CLI reads the project .env and .gemini/.env) that sets LD_PRELOAD, LD_AUDIT, DYLD_INSERT_LIBRARIES
// or another preload variable to a value loads a library into the shell of every hook before the hook runs, so the hooks refuse that write.
// Every shell write to such a file is refused too, whatever it writes (the loader name it mentions only picks the message). Fixtures are inert text: the paths name no real library.

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
const OPAQUE = /Edit \.env with the file editor tool; shell writes to \.env files are blocked\. zn cannot see what the shell actually writes\./;
const OPAQUE_OR_NAMED = /shell writes to \.env files are blocked|would set [A-Z0-9_]+ for the agent/;
const isEnv = (t) => /(^|[\\/])\.env$/.test(t);

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

test('shell writes of a preload variable to a .env are blocked, an empty value too', async (t) => {
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
  // Policy changed (2026-11-25): an empty value used to pass as a literal write; every shell write to a .env is refused now.
  for (const command of ['echo LD_PRELOAD= >> .env', "echo 'LD_PRELOAD=' >> .env", 'echo LD_LIBRARY_PATH=/opt/lib >> .env']) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), OPAQUE_OR_NAMED, command);
  }
  passes(await decide(claude, cc('Bash', { command: 'echo LD_PRELOAD=/tmp/x.so > notes.txt' }, dir)));
});

test('shell writes to a .env whose text only the shell knows are blocked, also when only a value is expanded', async (t) => {
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
  // A name computed right before "=".
  for (const command of ["printf '%s=%s\\n' \"$K\" \"$V\" > .env", 'echo "A_$N=1" >> .env']) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), OPAQUE, command);
  }
  // Policy changed (2026-11-25): these used to pass because the variable names were literal and only values were expanded, or because
  // the text came from another file. A shell write to a .env must now be literal text: any $ (even in single quotes), a printf
  // conversion, an in-place sed, a here-document with an unquoted delimiter, a $( ) anywhere before the write, a target with a variable,
  // and a copy from another file are refused.
  const nowRefused = [
    'echo "API_URL=$URL" >> .env',
    "printf 'TOKEN=%s\\n' \"$T\" >> .env",
    'printf "PORT=%s\\nHOST=%s\\n" "$P" "$H" > .env',
    'echo API_URL=$HOME/api >> .env',
    'export TOKEN=$(cat token.txt) && echo FOO=1 >> .env',
    "sed -i \"s|^TOKEN=.*|TOKEN=$T|\" .env",
    'echo "A=1" >> "$PWD/.env"',
    'cat > .env <<EOF\nAPI_URL=$URL\nexport TOKEN=$T\nEOF',
    "echo 'LITERAL=$NOT_EXPANDED' >> .env",
    'cp .env.example .env',
    'cat template.txt > .env',
  ];
  for (const command of nowRefused) blocked(await decide(claude, cc('Bash', { command }, dir)), OPAQUE, command);
  // Literal writes are refused too.
  for (const command of ['echo FOO=1 >> .env # $X', '[ -f .env ] || echo FOO=1 > .env', "echo 'API_URL=https://example.com' >> .env"]) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), OPAQUE, command);
  }
  // A literal name that is a loader name keeps its own refusal even with an expanded value.
  blocked(await decide(claude, cc('Bash', { command: 'echo "LD_PRELOAD=$LIB" >> .env' }, dir)), PRELOAD('LD_PRELOAD'));
  blocked(await decide(claude, cc('Bash', { command: 'echo "LD_DEBUG=$X" >> .env' }, dir)), /would set LD_DEBUG for the agent/);
});

test('copies from another file into a .env are refused: zn cannot see what they write', async (t) => {
  const dir = project(t);
  // Policy changed (2026-11-25): the first three used to pass because the source was named literally.
  for (const command of ['cp other.env .env', 'cat other.env > .env', 'tee .env < other.env', 'cp "$SRC" .env', 'cat "$SRC" > .env', 'cat *.env > .env']) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), OPAQUE, command);
  }
});

test('the shell write scan is linear in the length of the command', () => {
  const build = (n) => 'echo ' + '"A=$X" '.repeat(n) + '"$Y" > .env';
  assertLinear((cmd) => loaderEnv.shellDotenvWrite(cmd, isEnv), build, 20000, 'many expansions before the redirection');
  assert.equal(loaderEnv.shellDotenvWrite(build(20000), isEnv).verdict, loaderEnv.OPAQUE_WRITE);
  const literal = (n) => 'echo ' + "'A_B_C=1' ".repeat(n) + '> notes.txt';
  assertLinear((cmd) => loaderEnv.shellDotenvWrite(cmd, isEnv), literal, 20000, 'many literal words');
  assert.equal(loaderEnv.shellDotenvWrite(literal(20000), isEnv).verdict, null);
  const blind = (n) => 'echo "$(x)"; ' + '>'.repeat(n) + ' .env';
  assertLinear((cmd) => loaderEnv.shellDotenvWrite(cmd, isEnv), blind, 20000, 'many > after a substitution');
});

test('a printf conversion outside a literal NAME= value is refused even with literal arguments: it can assemble a loader name', async (t) => {
  const dir = project(t);
  const bad = [
    "printf '%s%s\\n' LD_ DEBUG=help > .env",
    "printf '%s%s=%s\\n' LD_ PRELOAD /tmp/x.so >> .env",
    "printf '%s\\n' LD_DEBUG=help > .env",
    "printf '%s_%s=%s\\n' LD PRELOAD /tmp/x.so >> .env",
    "printf -- '%s%s\\n' LD_ DEBUG=help > .env",
  ];
  for (const command of bad) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), null, command);
    blocked(await decide(gemini, gem('run_shell_command', { command }, dir)), null, command);
  }
  for (const command of ["printf '%s%s\\n' LD_ DEBUG=help > .env", "printf '%s%s=%s\\n' LD_ PRELOAD /tmp/x.so >> .env"]) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), OPAQUE_OR_NAMED, command);
  }
  // Policy changed (2026-11-25): a printf format is no longer parsed. These used to pass because their conversions sat in a value;
  // any % or backslash in a printf that writes a .env is now refused.
  const nowRefused = [
    "printf 'TOKEN=%s\\n' abc >> .env",
    "printf 'A=%s\\nB=%s\\n' x y >> .env",
    "printf 'X=1\\n' >> .env",
    "printf 'X=100%%\\n' >> .env",
  ];
  for (const command of nowRefused) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), OPAQUE, command);
    blocked(await decide(gemini, gem('run_shell_command', { command }, dir)), OPAQUE, command);
  }
  // A printf of plain text, one argument, used to pass; it is refused now.
  for (const command of ["printf 'X=1' >> .env", 'printf TOKEN=abc > .env']) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), OPAQUE, command);
    blocked(await decide(gemini, gem('run_shell_command', { command }, dir)), OPAQUE, command);
  }
});

test('printf is found in any position of a simple command, not only as the first word', async (t) => {
  const dir = project(t);
  const bad = [
    "env printf '%s%s\\n' LD_ DEBUG=help > .env",
    "X=1 printf '%s%s\\n' LD_ DEBUG=help > .env",
    "command printf '%s%s\\n' LD_ DEBUG=help >> .env",
    "\"printf\" '%s%s\\n' LD_ DEBUG=help > .env",
    "\\printf '%s%s\\n' LD_ DEBUG=help > .env",
    "env printf '%s%s=%s\\n' LD_ PRELOAD /tmp/x.so > .env",
    "true && env printf '%s%s\\n' LD_ DEBUG=help > .env",
    "sudo printf '%s%s\\n' LD_ DEBUG=help > .env",
    "echo x | xargs printf '%s%s\\n' LD_ DEBUG=help > .env",
    "env printf -v V '%s%s' LD_ DEBUG=help > .env",
  ];
  for (const command of bad) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), null, command);
    blocked(await decide(gemini, gem('run_shell_command', { command }, dir)), null, command);
  }
  // Policy changed (2026-11-25): printf behind a wrapper or a VAR=value prefix is refused even with a value-only conversion; these
  // two used to pass. Every shell write to a watched .env is refused now, whatever the command.
  const nowRefused = [
    "env printf 'TOKEN=%s\\n' abc >> .env",
    "X=1 printf 'A=%s\\n' b >> .env",
    "env printf 'A=1' >> .env",
    "X=1 printf 'A=1' >> .env",
  ];
  for (const command of nowRefused) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), OPAQUE, command);
    blocked(await decide(gemini, gem('run_shell_command', { command }, dir)), OPAQUE, command);
  }
  assert.equal(loaderEnv.shellDotenvWrite("env printf '%s%s\\n' LD_ DEBUG=help > .env", isEnv).verdict, loaderEnv.OPAQUE_WRITE);
  assert.equal(loaderEnv.shellDotenvWrite('xargs printf > .env', isEnv).verdict, loaderEnv.OPAQUE_WRITE);
  assert.equal(loaderEnv.shellDotenvWrite("env printf 'A=1' >> .env", isEnv).verdict, loaderEnv.OPAQUE_WRITE);
  assert.equal(loaderEnv.shellDotenvWrite("printf 'A=1' >> .env", isEnv).verdict, loaderEnv.OPAQUE_WRITE);
});

test('a printf format escape other than backslash, tab and quotes may emit a line break, and %b interprets escapes: both end a literal value', async (t) => {
  const dir = project(t);
  const bad = [
    "printf 'A=%s\\x0a%s%s=x\\n' a LD_ PRELOAD > .env",
    "printf 'A=%s\\012%s=%s\\n' a LD_PRELOAD x > .env",
    "printf 'A=%s\\u000a%s%s\\n' a LD_ DEBUG=help > .env",
    "printf 'A=%b\\n' 'x\\nLD_DEBUG=help' > .env",
    "printf 'A=%s\\vLD_%s\\n' a DEBUG=help > .env",
  ];
  for (const command of bad) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), null, command);
    blocked(await decide(gemini, gem('run_shell_command', { command }, dir)), null, command);
  }
  // Policy changed (2026-11-25): these used to pass; a printf with any % or backslash that writes a .env is now refused.
  const nowRefused = [
    "printf 'TOKEN=%s\\n' abc >> .env",
    "printf 'A=%s\\tB\\n' x >> .env",
    "printf 'A=%s\\n' 'x\\\\y' >> .env",
    "printf 'X=100%%\\n' >> .env",
  ];
  for (const command of nowRefused) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), OPAQUE, command);
    blocked(await decide(gemini, gem('run_shell_command', { command }, dir)), OPAQUE, command);
  }
  // %b with any width or flags is refused too.
  for (const command of ["printf '%0000000bLD_%s=%s\\n' x DEBUG help > .env", "printf '%-20b' x > .env", "printf '%b' 'A=1' > .env"]) {
    blocked(await decide(claude, cc('Bash', { command }, dir)), OPAQUE_OR_NAMED, command);
  }
});
