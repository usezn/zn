'use strict';
// Writes to a watched dotenv file through a file tool, an edit, a patch, an unknown tool or an MCP server are judged on the file they
// leave; when zn cannot work that file out, the write is refused. One test per class of the review, refused and benign cases side by
// side. Fixtures are inert text: the loader names are only written to temporary .env files, never set.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runner = require('../lib/hooks/runner');
const policy = require('../lib/hooks/policy');
const loaderEnv = require('../lib/loader-env');
const claude = require('../lib/agents/claude-code');
const gemini = require('../lib/agents/gemini');
const codex = require('../lib/agents/codex');
const copilot = require('../lib/agents/copilot');
const cursor = require('../lib/agents/cursor');
const opencode = require('../lib/agents/opencode');
const antigravity = require('../lib/agents/antigravity');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

function project(t) {
  const dir = tempDir(t, 'zn-ldfile-');
  fs.mkdirSync(path.join(dir, '.gemini'), { recursive: true });
  return dir;
}

// Some adapters refuse an unreadable call in their own answer, not in the decision: look at both.
async function denied(adapter, raw) {
  const res = await runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
  const out = res.output;
  const outDeny = Boolean(out && (out.decision === 'deny' || out.permission === 'deny' || out.permissionDecision === 'deny' ||
    (out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny')));
  return { deny: (res.decision && res.decision.decision === 'deny') || outDeny, res };
}
const refused = async (adapter, raw, what) => { const r = await denied(adapter, raw); assert.equal(r.deny, true, (what || '') + ' ' + JSON.stringify(r.res.decision)); };
const allowed = async (adapter, raw, what) => { const r = await denied(adapter, raw); assert.equal(r.deny, false, (what || '') + ' ' + JSON.stringify(r.res.decision)); };

const cc = (dir, tool_name, tool_input) => ({ session_id: 's', cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't' });
const gem = (dir, tool_name, tool_input) => ({ session_id: 's', cwd: dir, hook_event_name: 'BeforeTool', tool_name, tool_input });
const cdx = (dir, tool_name, tool_input) => ({ session_id: 's', cwd: dir, hook_event_name: 'PreToolUse', tool_name, tool_input, turn_id: 'u', tool_use_id: 't' });
const cop = (dir, toolName, args) => ({ sessionId: 's1', timestamp: 1792400000000, cwd: dir, toolName, toolArgs: JSON.stringify(args) });
const oc = (dir, tool, args) => ({ hook: 'tool.execute.before', tool, args, cwd: dir, sessionID: 's' });
const ag = (dir, name, args) => ({ conversationId: 'c1', workspacePaths: [dir], toolCall: { name, args } });
const cur = (dir, tool_name, args) => ({ hook_event_name: 'beforeMCPExecution', conversation_id: 'c', cwd: dir, tool_name, mcp_server_name: 'fs', tool_input: JSON.stringify(args) });

// Class 5: dotenv syntax with white space or line breaks around = and :, a value on the next line, and names split by quotes or a
// backslash before the line break.
test('class 5: dotenv whitespace, next-line values and split names are read as the assignment they are', async (t) => {
  const stop = ['LD_DEBUG\n=help\n', 'LD_DEBUG=\nhelp\n', 'LD_DEBUG\r=help\n', 'LD_DEBUG=\r\nhelp\n', 'LD_DEBUG:\nhelp\n', 'LD_DEBUG\v=help\n',
    'LD_DEBUG\f:\fhelp\n', 'LD_TRACE_LOADED_OBJECTS\n=1\n', 'LD_TRACE_LOADED_OBJECTS:\n1\n', "export LD_DE''BUG=help\n", 'LD_\\\nDEBUG=help\n',
    'LD_DEBUG=\n"help"\n'];
  for (const s of stop) assert.notEqual(loaderEnv.hookStopAssignedIn(s), null, JSON.stringify(s));
  const preload = ['LD_PRELOAD\n=/tmp/x.so\n', 'LD_PRELOAD=\n/tmp/x.so\n', 'LD_PRELOAD:\n/tmp/x.so\n', 'LD_PRELOAD\r\n=\r\n/tmp/x.so\r\n',
    'LD_PRELOAD\v=\f/tmp/x.so\n', "export LD_PRE''LOAD=/tmp/x.so\n", 'export LD_PRE"LOAD"=/tmp/x.so\n', 'LD_\\\nPRELOAD=/tmp/x.so\n',
    'LD_PRE\\\nLOAD=/tmp/x.so\n', 'LD_PRELOAD=\n\n  "/tmp/x.so"\n', "LD_PRE''LOAD\n=/tmp/x.so\n"];
  for (const s of preload) assert.equal(loaderEnv.preloadAssignedIn(s), 'LD_PRELOAD', JSON.stringify(s));
  // A name that mentions LD_ but is not plain: which variable it sets is not plain to see.
  for (const s of ['LD_${X}PRELOAD=/tmp/x.so\n', '"LD_PRELOAD" = x\n', 'export LD_PRE$(echo)LOAD=1\n']) assert.equal(loaderEnv.obscureLoaderKeyIn(s), true, s);
  // In-limit cases stay allowed.
  for (const s of ['LD_DEBUG=all\nFOO=help\n', 'LD_DEBUG=\nFOO=1\n', 'FOO=1\nLD_PRELOAD=\n', 'LD_PRELOAD=""\nLD_AUDIT=\'\'\n', 'LD_LIBRARY_PATH=/opt/lib\n',
    'OLD_VALUE=1\nMY_LD_PRELOAD=x\n', '# LD_PRE"LOAD"=x\n', 'export LD_DEBUG="all"\n']) {
    assert.equal(loaderEnv.hookStopAssignedIn(s), null, JSON.stringify(s));
    assert.equal(loaderEnv.preloadAssignedIn(s), null, JSON.stringify(s));
    assert.equal(loaderEnv.obscureLoaderKeyIn(s), false, JSON.stringify(s));
  }
  // Through the write tools.
  const dir = project(t);
  const env = path.join(dir, '.env');
  for (const content of ['LD_PRELOAD\n=/tmp/x.so\n', 'LD_DEBUG=\nhelp\n', "export LD_PRE''LOAD=/tmp/x.so\n", 'LD_\\\nPRELOAD=/tmp/x.so\n', 'LD_${X}PRELOAD=/tmp/x.so\n']) {
    await refused(claude, cc(dir, 'Write', { file_path: env, content }), 'claude write ' + JSON.stringify(content));
    await refused(gemini, gem(dir, 'write_file', { file_path: path.join(dir, '.gemini', '.env'), content }), 'gemini write ' + JSON.stringify(content));
  }
  await allowed(claude, cc(dir, 'Write', { file_path: env, content: 'PORT=3000\nLD_DEBUG=all\nLD_LIBRARY_PATH=/opt/lib\n' }), 'benign write');
});

// Class 6: an unknown tool that carries a command and also names a .env file with a body.
test('class 6: an unknown command tool that also writes a .env is judged on what it writes', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  await refused(copilot, cop(dir, 'custom_runner', { command: 'cat', path: env, content: 'LD_PRELOAD=/tmp/x.so' }), 'copilot');
  await refused(claude, cc(dir, 'custom_runner', { command: 'cat', path: env, content: 'LD_PRELOAD=/tmp/x.so' }), 'claude');
  await refused(antigravity, ag(dir, 'custom_runner', { CommandLine: 'cat', path: env, content: 'LD_DEBUG=help' }), 'antigravity');
  // A benign body sent to a tool zn does not know is refused too: zn cannot tell whether the tool writes it as the whole file.
  await refused(copilot, cop(dir, 'custom_runner', { command: 'cat', path: env, content: 'PORT=1' }), 'copilot benign body');
  await refused(claude, cc(dir, 'custom_runner', { command: 'cat', path: env, content: 'PORT=1' }), 'claude benign body');
  // In limit: the loader text for a file that is not watched.
  await allowed(antigravity, ag(dir, 'custom_runner', { CommandLine: 'ls', path: path.join(dir, 'notes.txt'), content: 'LD_DEBUG=help' }), 'antigravity other file');
});

// Class 7: edits that change only a value are judged on the file they leave, in every agent's spelling, nested ones too.
test('class 7: OpenCode, Antigravity, MCP and nested edits of a .env are judged on the file they leave', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'PORT=1\nLD_DEBUG=all\n');
  await refused(opencode, oc(dir, 'edit', { filePath: env, oldString: 'all', newString: 'help' }), 'opencode edit');
  await refused(antigravity, ag(dir, 'replace_file_content', { TargetFile: env, TargetContent: 'all', ReplacementContent: 'help' }), 'antigravity replace');
  await refused(antigravity, ag(dir, 'multi_replace_file_content', { TargetFile: env, ReplacementChunks: [{ TargetContent: 'PORT=1', ReplacementContent: 'PORT=2' }, { TargetContent: 'all', ReplacementContent: 'help' }] }), 'antigravity multi');
  await refused(claude, cc(dir, 'mcp__fs__edit_file', { path: env, edits: [{ oldText: 'all', newText: 'help' }] }), 'claude mcp edit_file');
  await refused(claude, cc(dir, 'files_helper', { file: env, edit: { old_string: 'all', new_string: 'help' } }), 'claude nested edit');
  await refused(claude, cc(dir, 'files_helper', { file: env, change: { old_text: 'all', new_text: 'help' } }), 'claude old_text');
  await refused(claude, cc(dir, 'files_helper', { file: env, change: [{ Target: 'all', Replacement: 'help' }] }), 'claude Target');
  // An edit or replace tool whose change cannot be reconstructed: refused.
  await refused(antigravity, ag(dir, 'edit_file', { TargetFile: env, CodeEdit: '// ... existing code ...\nLD_DEBUG=x', Instruction: 'x' }), 'antigravity edit_file');
  await refused(antigravity, ag(dir, 'replace_file_content', { TargetFile: env, TargetContent: 'missing', ReplacementContent: 'x' }), 'target not found');
  // In limit: the same shapes with a benign result pass.
  await allowed(opencode, oc(dir, 'edit', { filePath: env, oldString: 'PORT=1', newString: 'PORT=2' }), 'opencode benign');
  await allowed(antigravity, ag(dir, 'replace_file_content', { TargetFile: env, TargetContent: 'all', ReplacementContent: 'libs' }), 'antigravity benign');
  await allowed(antigravity, ag(dir, 'multi_replace_file_content', { TargetFile: env, ReplacementChunks: [{ TargetContent: 'PORT=1', ReplacementContent: 'PORT=2' }] }), 'antigravity multi benign');
  // An MCP tool or a tool zn does not know is never trusted to apply an edit as zn would: refused even with a harmless result.
  await refused(claude, cc(dir, 'mcp__fs__edit_file', { path: env, edits: [{ oldText: 'PORT=1', newText: 'PORT=3' }] }), 'mcp benign');
  await refused(claude, cc(dir, 'files_helper', { file: env, edit: { old_string: 'PORT=1', new_string: 'PORT=4' } }), 'nested benign');
});

// Class 8: apply_patch hunks are applied to the file on disk, and a move into a .env reads its source.
test('class 8: apply_patch updates and moves into a .env are judged on the file they leave', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  const P = (...lines) => '*** Begin Patch\n' + lines.join('\n') + '\n*** End Patch\n';
  // A multi-line quoted value whose name is outside the hunk.
  fs.writeFileSync(env, 'PORT=1\nLD_DEBUG="all\nfoo\nbar\nbaz\nlibs"\n');
  const partial = P('*** Update File: .env', '@@', ' baz', '-libs"', '+help"');
  await refused(codex, cdx(dir, 'apply_patch', { command: partial }), 'codex partial hunk');
  await refused(opencode, oc(dir, 'apply_patch', { patchText: partial }), 'opencode partial hunk');
  await refused(copilot, cop(dir, 'apply_patch', { input: partial }), 'copilot partial hunk');
  // A clean file moved into .env.
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'LD_PRELOAD=/tmp/x.so\nTITLE=a\n');
  const move = P('*** Update File: notes.txt', '*** Move to: .env', '@@', '-TITLE=a', '+TITLE=b');
  await refused(codex, cdx(dir, 'apply_patch', { command: move }), 'codex move');
  await refused(opencode, oc(dir, 'apply_patch', { patchText: move }), 'opencode move');
  // A move from a source that does not exist, a hunk that is not found or is found twice, a line the format does not have.
  await refused(codex, cdx(dir, 'apply_patch', { command: P('*** Update File: gone.txt', '*** Move to: .env', '@@', '-A=1', '+A=2') }), 'missing source');
  await refused(codex, cdx(dir, 'apply_patch', { command: P('*** Update File: .env', '@@', '-NOPE=1', '+NOPE=2') }), 'hunk not found');
  fs.writeFileSync(env, 'A=1\nA=1\n');
  await refused(codex, cdx(dir, 'apply_patch', { command: P('*** Update File: .env', '@@', '-A=1', '+A=2') }), 'hunk found twice');
  await refused(codex, cdx(dir, 'apply_patch', { command: P('*** Update File: .env', '@@', '?A=1') }), 'odd line');
  // In limit: benign updates, adds and moves pass.
  fs.writeFileSync(env, 'PORT=1\nLD_DEBUG=all\n');
  await allowed(codex, cdx(dir, 'apply_patch', { command: P('*** Update File: .env', '@@', ' PORT=1', '-LD_DEBUG=all', '+LD_DEBUG=libs') }), 'codex benign update');
  await allowed(opencode, oc(dir, 'apply_patch', { patchText: P('*** Update File: .env', '@@', '-PORT=1', '+PORT=2') }), 'opencode benign update');
  await allowed(codex, cdx(dir, 'apply_patch', { command: P('*** Update File: .env', '@@', '+EXTRA=1') }), 'append');
  await allowed(codex, cdx(dir, 'apply_patch', { command: P('*** Add File: .env.local', '+PORT=5') }), 'add');
  fs.writeFileSync(path.join(dir, 'clean.txt'), 'PORT=9\n');
  await allowed(codex, cdx(dir, 'apply_patch', { command: P('*** Update File: clean.txt', '*** Move to: .env.test', '@@', '-PORT=9', '+PORT=8') }), 'benign move');
  // The reconstruction itself.
  assert.equal(runner.applyHunks('A=1\nB=2\n', ['@@', ' A=1', '-B=2', '+B=3']), 'A=1\nB=3\n');
  assert.equal(runner.applyHunks('A=1\n', ['@@', '+B=2']), 'A=1\nB=2\n');
  assert.equal(runner.applyHunks('A=1\r\n', ['@@', '-A=1', '+A=2']), null);
});

// Class 9: MCP writes to a .env in Claude Code, Codex CLI, Cursor and OpenCode.
test('class 9: MCP writes to a .env are judged in Claude Code, Codex CLI, Cursor and OpenCode', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  for (const content of ['LD_PRELOAD=/tmp/x.so', 'LD_DEBUG=help']) {
    await refused(claude, cc(dir, 'mcp__fs__write_file', { path: env, content }), 'claude ' + content);
    await refused(codex, cdx(dir, 'mcp__fs__write_file', { path: env, content }), 'codex ' + content);
    await refused(cursor, cur(dir, 'write_file', { path: env, content }), 'cursor ' + content);
    await refused(opencode, oc(dir, 'fs_write_file', { path: env, content }), 'opencode ' + content);
  }
  await refused(claude, cc(dir, 'mcp__fs__write_file', { path: '.env', content: 'LD_PRELOAD=/tmp/x.so' }), 'relative path');
  // An address nested deeper than zn reads, in a call whose text names a .env: refused. A deep call that names no such file is not.
  const { MAX_NEST_DEPTH } = require('../lib/nest-limits');
  const nest = (n, leaf) => { let v = leaf; for (let i = 0; i < n; i++) v = { level: v }; return v; };
  await refused(claude, cc(dir, 'mcp__fs__write_file', nest(MAX_NEST_DEPTH + 2, { path: env, content: 'LD_PRELOAD=/tmp/x.so' })), 'deep');
  await refused(codex, cdx(dir, 'mcp__fs__write_file', nest(MAX_NEST_DEPTH + 2, { path: env, content: 'PORT=1' })), 'deep benign body');
  await allowed(claude, cc(dir, 'mcp__fs__call', nest(MAX_NEST_DEPTH + 2, { note: 'hello' })), 'deep, no file');
  // A benign body to a .env is refused too (no MCP tool is trusted by name); the loader text written to a file that is not watched passes.
  for (const content of ['PORT=1']) {
    await refused(claude, cc(dir, 'mcp__fs__write_file', { path: env, content }), 'claude benign body');
    await refused(codex, cdx(dir, 'mcp__fs__write_file', { path: env, content }), 'codex benign body');
    await refused(cursor, cur(dir, 'write_file', { path: env, content }), 'cursor benign body');
    await refused(opencode, oc(dir, 'fs_write_file', { path: env, content }), 'opencode benign body');
  }
  for (const [p, content] of [[path.join(dir, 'notes.txt'), 'LD_PRELOAD=/tmp/x.so']]) {
    await allowed(claude, cc(dir, 'mcp__fs__write_file', { path: p, content }), 'claude benign ' + p);
    await allowed(codex, cdx(dir, 'mcp__fs__write_file', { path: p, content }), 'codex benign ' + p);
    await allowed(cursor, cur(dir, 'write_file', { path: p, content }), 'cursor benign ' + p);
    await allowed(opencode, oc(dir, 'fs_write_file', { path: p, content }), 'opencode benign ' + p);
  }
});

// Class 10: a copy, move, rename or link into a .env, or a tool zn does not know that names one, gives zn no file to judge: refused,
// through MCP servers and unknown tools alike. Reads of a .env and copies between other files keep working.
test('class 10: MCP copy/rename/unknown into .env is refused', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  const src = path.join(dir, 'notes.txt');
  fs.writeFileSync(env, 'PORT=1\n');
  fs.writeFileSync(src, 'LD_PRELOAD=/tmp/x.so\n');
  const shapes = [
    ['copy_file', { source: src, destination: env }],
    ['move_file', { source: src, destination: env }],
    ['rename', { from: src, to: env }],
    ['create_symlink', { target: src, link: '.env' }],
    ['do_thing', { src, dst: env }],
    ['do_thing', { a: { b: src, c: '.env.local' } }],
  ];
  for (const [name, args] of shapes) {
    const what = name + ' ' + JSON.stringify(args);
    await refused(claude, cc(dir, 'mcp__fs__' + name, args), 'claude ' + what);
    await refused(codex, cdx(dir, 'mcp__fs__' + name, args), 'codex ' + what);
    await refused(cursor, cur(dir, name, args), 'cursor ' + what);
    await refused(opencode, oc(dir, 'fs_' + name, args), 'opencode ' + what);
    await refused(gemini, gem(dir, 'mcp_fs_' + name, args), 'gemini ' + what);
    await refused(antigravity, ag(dir, 'mcp_fs_' + name, args), 'antigravity ' + what);
    await refused(copilot, cop(dir, 'fs-' + name, args), 'copilot ' + what);
  }
  // The source of a copy or move may be the .env too: the call still names it without its content.
  await refused(claude, cc(dir, 'mcp__fs__move_file', { source: env, destination: src }), 'move out of .env');
  // Tools that are not MCP tools: an unknown tool that names files, and one that also carries a command.
  await refused(claude, cc(dir, 'file_mover', { source: src, destination: env }), 'claude unknown file tool');
  await refused(copilot, cop(dir, 'file_mover', { source: src, destination: env }), 'copilot unknown file tool');
  await refused(claude, cc(dir, 'custom_runner', { command: 'cp', from: src, to: env }), 'claude unknown command tool');
  await refused(copilot, cop(dir, 'custom_runner', { command: 'cp', path: env }), 'copilot unknown command tool');
  // In limit: a list of a folder and copies between files that are not watched pass. A call that names the .env is refused whatever
  // the tool is called (see the read_file test below).
  for (const [name, args] of [['list_directory', { path: dir }], ['read_file', { path: src }]]) {
    await allowed(claude, cc(dir, 'mcp__fs__' + name, args), 'claude read ' + name);
    await allowed(opencode, oc(dir, 'fs_' + name, args), 'opencode read ' + name);
  }
  const other = path.join(dir, 'copy.txt');
  await allowed(claude, cc(dir, 'mcp__fs__copy_file', { source: src, destination: other }), 'claude copy other');
  await allowed(opencode, oc(dir, 'fs_move_file', { source: src, destination: other }), 'opencode move other');
  await allowed(cursor, cur(dir, 'copy_file', { source: src, destination: other }), 'cursor copy other');
  await allowed(codex, cdx(dir, 'mcp__fs__copy_file', { source: src, destination: other }), 'codex copy other');
  await allowed(gemini, gem(dir, 'mcp_fs_copy_file', { source: src, destination: other }), 'gemini copy other');
  await allowed(antigravity, ag(dir, 'mcp_fs_move_file', { source: src, destination: other }), 'antigravity move other');
  // An MCP write is never judged on its body or edit (see the write_file test below); the agent's own Write is.
  await refused(claude, cc(dir, 'mcp__fs__write_file', { path: env, content: 'PORT=2' }), 'write body');
  await refused(claude, cc(dir, 'mcp__fs__edit_file', { path: env, edits: [{ oldText: 'PORT=1', newText: 'PORT=3' }] }), 'edit');
  await allowed(claude, cc(dir, 'Write', { file_path: env, content: 'PORT=2' }), 'own write body');
});

// Read-only allowlist: git steps that write stored content into the worktree (checkout, restore, reset, stash) are not read-only for
// a command that names a watched dotenv file; add, commit and rm --cached only change the index or the history.
test('read-only allowlist: git checkout, restore, reset and stash that name a .env are refused, index-only git steps pass', async (t) => {
  const dir = project(t);
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=1\n');
  const bash = (command) => cc(dir, 'Bash', { command });
  for (const command of ['git checkout -- .env', 'git checkout HEAD -- .env.local', 'git restore .env', 'git restore --source=HEAD~1 .env',
    'git reset --hard && cat .env', 'git reset -- .env', 'git stash pop && cat .env', 'git stash apply && cat .env', 'git stash push .env']) {
    const r = await denied(claude, bash(command));
    assert.equal(r.deny, true, command + ' ' + JSON.stringify(r.res.decision));
  }
  const r = await denied(claude, bash('git checkout -- .env'));
  assert.match(JSON.stringify(r.res.decision), /file editor tool/);
  for (const command of ['git add .env', 'git commit -m x .env', 'git rm --cached .env', 'git status .env']) {
    await allowed(claude, bash(command), command);
  }
});

// Class 10 refinement: a tool zn does not know (not an MCP tool) is read under any key and at any depth, so a .env named as src, dst,
// from, to or deep inside the arguments is found; arguments zn cannot walk to the end are refused.
test('class 10: unknown tools that name a .env under any key or too deep are refused', async (t) => {
  const dir = project(t);
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: '.env' } } } } } } } };
  const cases = [[{ src: 'a', dst: '.env' }, 'src/dst'], [{ from: '.env.local', to: 'b' }, 'from/to'],
    [{ x: { y: { target: '.env' } } }, 'nested'], [deep, 'over-deep']];
  for (const [args, what] of cases) {
    await refused(claude, cc(dir, 'file_mover', args), 'claude ' + what);
    await refused(antigravity, ag(dir, 'file_mover', args), 'antigravity ' + what);
    await refused(gemini, gem(dir, 'file_mover', args), 'gemini ' + what);
    await refused(copilot, cop(dir, 'file_mover', args), 'copilot ' + what);
  }
  // A command tool that also names a .env under such a key keeps the check.
  await refused(claude, cc(dir, 'custom_runner', { command: 'true', dst: '.env' }), 'claude command tool dst');
  await refused(antigravity, ag(dir, 'custom_runner', { command: 'true', dst: '.env' }), 'antigravity command tool dst');
  // Files that are not watched pass.
  await allowed(claude, cc(dir, 'file_mover', { src: 'a', dst: 'b.txt' }), 'claude other');
  await allowed(antigravity, ag(dir, 'file_mover', { src: 'a', dst: 'b.txt' }), 'antigravity other');
  await allowed(gemini, gem(dir, 'file_mover', { src: 'a', dst: 'b.txt' }), 'gemini other');
});

// Class 10: an MCP tool named read_file that names a .env is refused. The name of an MCP tool proves nothing: a custom server can call
// a writing tool read_file, and with no complete resulting text zn cannot see what it leaves. There is no read-only exemption by name
// for MCP tools, whatever the prefix or lack of one an agent gives them.
test('class 10: an MCP tool named read_file that names a .env is refused', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'PORT=1\n');
  const src = path.join(dir, 'src.txt');
  const readNames = ['read_file', 'read_text_file', 'read_media_file', 'read_multiple_files', 'list_directory', 'get_file_info', 'search_files'];
  // The filesystem server's own read tools and a custom server's writer that is called read_file, under every prefix style.
  const shapes = [{ path: env }, { path: env, content: 'LD_DEBUG=al\n', append: true }, { path: env, text: 'x' },
    { source: src, destination: env }, { path: env, edits: [{ oldText: 'PORT=1', newText: 'LD_DEBUG=help' }] }];
  for (const name of readNames) {
    for (const args of shapes) {
      const what = name + ' ' + JSON.stringify(args);
      await refused(claude, cc(dir, 'mcp__fs__' + name, args), 'claude ' + what);
      await refused(claude, cc(dir, 'mcp__custom_writer__' + name, args), 'claude custom ' + what);
      await refused(codex, cdx(dir, 'mcp__fs__' + name, args), 'codex ' + what);
      await refused(cursor, cur(dir, name, args), 'cursor ' + what);
      await refused(opencode, oc(dir, 'fs_' + name, args), 'opencode ' + what);
      await refused(gemini, gem(dir, 'mcp_fs_' + name, args), 'gemini ' + what);
      await refused(antigravity, ag(dir, 'mcp_fs_' + name, args), 'antigravity ' + what);
      await refused(copilot, cop(dir, 'fs-' + name, args), 'copilot ' + what);
    }
  }
  // Bare names: the adapters that can carry an MCP call without a server prefix do not trust a read-looking name either. Codex CLI
  // only sends Bash, apply_patch and mcp__ names to the hook (its matcher), and Gemini CLI and Antigravity prefix every MCP tool, so a
  // bare read_file there is the agent's own tool.
  for (const name of readNames) {
    const args = { path: env, content: 'LD_DEBUG=al\n', append: true };
    await refused(claude, cc(dir, name, args), 'claude bare ' + name);
    await refused(cursor, cur(dir, name, args), 'cursor bare ' + name);
    await refused(opencode, oc(dir, name, args), 'opencode bare ' + name);
    await refused(copilot, cop(dir, name, args), 'copilot bare ' + name);
  }
  // A call that does not name a watched file is not affected.
  await allowed(claude, cc(dir, 'mcp__custom_writer__read_file', { path: src }), 'claude other file');
  await allowed(opencode, oc(dir, 'fs_read_file', { path: src }), 'opencode other file');
  assert.equal(policy.readOnlyToolName, undefined);
});

// The agents' own read tools are not MCP calls: they are plain reads, which a .env may still get (a read is judged by the read
// checks, not by the unseen-write check).
test('class 10: the built-in read tool of each agent still reads a .env', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'PORT=1\n');
  await allowed(claude, cc(dir, 'Read', { file_path: env }), 'claude Read');
  await allowed(gemini, gem(dir, 'read_file', { file_path: env }), 'gemini read_file');
  await allowed(antigravity, ag(dir, 'view_file', { AbsolutePath: env }), 'antigravity view_file');
  await allowed(antigravity, ag(dir, 'read_file', { path: env }), 'antigravity read_file');
  await allowed(copilot, cop(dir, 'view', { path: env }), 'copilot view');
  await allowed(opencode, oc(dir, 'read', { filePath: env }), 'opencode read');
});

// Class 10: an MCP tool named write_file that appends to a .env is refused. The name proves nothing: a custom server can call an
// append operation write_file and send l,help to a file that ends in LD_DEBUG=al, leaving LD_DEBUG=all,help, with no append flag.
// Any MCP call that names a watched .env is refused, whatever the tool is called and even with a harmless full body; only the
// agent's own write and edit tools, where zn can work out the file they leave, may change it.
test('class 10: an MCP tool named write_file that appends to a .env is refused', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'PORT=1\nLD_DEBUG=al\n');
  const args = { path: env, content: 'l,help' };
  await refused(claude, cc(dir, 'mcp__custom__write_file', args), 'claude custom write_file');
  await refused(claude, cc(dir, 'mcp__filesystem__write_file', args), 'claude filesystem write_file');
  await refused(claude, cc(dir, 'mcp__filesystem__write_file', { path: env, content: 'PORT=2\n' }), 'claude filesystem harmless full body');
  await refused(codex, cdx(dir, 'mcp__custom__write_file', args), 'codex custom write_file');
  await refused(gemini, gem(dir, 'mcp_custom_write_file', { file_path: env, content: 'l,help' }), 'gemini prefixed write_file');
  await refused(antigravity, ag(dir, 'mcp_custom_write_file', { path: env, content: 'l,help' }), 'antigravity prefixed write_file');
  await refused(opencode, oc(dir, 'custom_write_file', args), 'opencode prefixed write_file');
  await refused(copilot, cop(dir, 'custom-write_file', args), 'copilot prefixed write_file');
  // Bare names in the agents that carry MCP calls without a server prefix.
  await refused(claude, cc(dir, 'write_file', args), 'claude bare write_file');
  await refused(cursor, cur(dir, 'write_file', args), 'cursor bare write_file');
  await refused(opencode, oc(dir, 'write_file', args), 'opencode bare write_file');
  await refused(copilot, cop(dir, 'write_file', args), 'copilot bare write_file');
  // The message of an MCP refusal says what to do instead.
  const r = await denied(claude, cc(dir, 'mcp__custom__write_file', args));
  assert.match(JSON.stringify(r.res.decision), /MCP tools may not touch \.env files/);
  // The agent's own write tools replace the file: a clean body passes.
  await allowed(claude, cc(dir, 'Write', { file_path: env, content: 'PORT=2\n' }), 'claude own Write clean');
  await allowed(gemini, gem(dir, 'write_file', { file_path: env, content: 'PORT=2\n' }), 'gemini own write_file clean');
  assert.equal(fs.readFileSync(env, 'utf8'), 'PORT=1\nLD_DEBUG=al\n');
});

// Class 10 refinement: a body only gives zn the file a call leaves when the tool is a known whole-body write tool (by exact name, or
// the filesystem server's write_file after an MCP prefix) with no append, insert or mode flag, or when zn applied an edit or a patch
// to the file on disk. A tool zn does not know may append its text: LD_DEBUG=al plus l,help leaves LD_DEBUG=all,help.
test('class 10: unknown append semantics are refused, only known whole-body writes and edits read from disk count as seen', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'PORT=1\nLD_DEBUG=al\n');
  const body = { content: 'l,help' };
  // Tools zn does not know, in each agent's spelling.
  await refused(claude, cc(dir, 'append_file', { path: '.env', ...body }), 'claude append_file');
  await refused(claude, cc(dir, 'mcp__x__append', { path: env, ...body }), 'claude mcp append');
  await refused(codex, cdx(dir, 'mcp__x__append', { path: env, ...body }), 'codex mcp append');
  await refused(cursor, cur(dir, 'append', { path: env, ...body }), 'cursor mcp append');
  await refused(opencode, oc(dir, 'x_append', { path: env, ...body }), 'opencode append');
  await refused(gemini, gem(dir, 'mcp_x_append', { path: env, ...body }), 'gemini mcp append');
  await refused(gemini, gem(dir, 'append_file', { file_path: env, ...body }), 'gemini append_file');
  await refused(antigravity, ag(dir, 'mcp_x_append', { path: env, ...body }), 'antigravity mcp append');
  await refused(copilot, cop(dir, 'x-append', { path: env, ...body }), 'copilot append');
  // A longer name that ends in write_file, or one that says append, is not the filesystem server's write_file.
  await refused(claude, cc(dir, 'mcp__fs__copy_and_write_file', { path: env, content: 'PORT=2' }), 'lookalike name');
  await refused(claude, cc(dir, 'mcp__fs__append_write_file', { path: env, content: 'PORT=2' }), 'append in name');
  // A known whole-body tool asked to append, insert or open the file in another mode.
  await refused(claude, cc(dir, 'mcp__fs__write_file', { path: env, ...body, append: true }), 'mcp write_file append');
  await refused(gemini, gem(dir, 'write_file', { file_path: env, ...body, append: true }), 'gemini write_file append');
  await refused(claude, cc(dir, 'mcp__fs__write_file', { path: env, ...body, mode: 'a' }), 'mode a');
  await refused(opencode, oc(dir, 'fs_write_file', { path: env, ...body, flags: 'a+' }), 'flags a+');
  await refused(claude, cc(dir, 'mcp__fs__write_file', { path: env, ...body, position: 20 }), 'position');
  // An unknown tool that sends a body next to an edit: the edit alone does not give the file.
  await refused(claude, cc(dir, 'files_helper', { file: env, ...body, edit: { old_string: 'PORT=1', new_string: 'PORT=2' } }), 'edit plus body');
  // The known whole-body write tools are still judged on their body.
  await refused(claude, cc(dir, 'Write', { file_path: env, content: 'PORT=1\nLD_PRELOAD=/tmp/x.so\n' }), 'Write preload');
  await refused(claude, cc(dir, 'mcp__fs__write_file', { path: env, content: 'LD_DEBUG=all,help\n' }), 'mcp write_file loader');
  // In limit: whole-body writes of a clean file, a plain overwrite mode, edits read from disk and reads pass.
  await allowed(claude, cc(dir, 'Write', { file_path: env, content: 'PORT=2\n' }), 'Write clean');
  await allowed(gemini, gem(dir, 'write_file', { file_path: env, content: 'PORT=2\n' }), 'gemini write_file clean');
  await allowed(opencode, oc(dir, 'write', { filePath: env, content: 'PORT=2\n' }), 'opencode write clean');
  await allowed(copilot, cop(dir, 'create', { path: env, file_text: 'PORT=2\n' }), 'copilot create clean');
  await refused(gemini, gem(dir, 'write_file', { file_path: env, content: 'LD_DEBUG=all,help\n' }), 'gemini write_file loader');
  await refused(opencode, oc(dir, 'write', { filePath: env, content: 'LD_DEBUG=all,help\n' }), 'opencode write loader');
  await refused(copilot, cop(dir, 'create', { path: env, file_text: 'LD_DEBUG=all,help\n' }), 'copilot create loader');
  await allowed(claude, cc(dir, 'Read', { file_path: env }), 'claude read');
  // The file is unchanged by these checks.
  assert.equal(fs.readFileSync(env, 'utf8'), 'PORT=1\nLD_DEBUG=al\n');
});
