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
  const outDeny = Boolean(out && (out.decision === 'deny' || out.permission === 'deny' ||
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
  // In limit: the same tools with a benign body, or the loader text for a file that is not watched.
  await allowed(copilot, cop(dir, 'custom_runner', { command: 'cat', path: env, content: 'PORT=1' }), 'copilot benign');
  await allowed(claude, cc(dir, 'custom_runner', { command: 'cat', path: env, content: 'PORT=1' }), 'claude benign');
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
  await allowed(claude, cc(dir, 'mcp__fs__edit_file', { path: env, edits: [{ oldText: 'PORT=1', newText: 'PORT=3' }] }), 'mcp benign');
  await allowed(claude, cc(dir, 'files_helper', { file: env, edit: { old_string: 'PORT=1', new_string: 'PORT=4' } }), 'nested benign');
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
  // In limit: a benign body, or the loader text written to a file that is not watched.
  for (const [p, content] of [[env, 'PORT=1'], [path.join(dir, 'notes.txt'), 'LD_PRELOAD=/tmp/x.so']]) {
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
  // In limit: reads of a .env through MCP keep their current answer, and copies between files that are not watched pass.
  for (const [name, args] of [['read_file', { path: env }], ['read_text_file', { path: env }], ['get_file_info', { path: env }],
    ['read_multiple_files', { paths: [env, src] }], ['list_directory', { path: dir }]]) {
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
  await allowed(gemini, gem(dir, 'mcp_fs_read_file', { path: env }), 'gemini read');
  await allowed(antigravity, ag(dir, 'mcp_fs_read_file', { path: env }), 'antigravity read');
  // A whole body or an edit applied to the file is still judged on what it leaves.
  await allowed(claude, cc(dir, 'mcp__fs__write_file', { path: env, content: 'PORT=2' }), 'write body');
  await allowed(claude, cc(dir, 'mcp__fs__edit_file', { path: env, edits: [{ oldText: 'PORT=1', newText: 'PORT=3' }] }), 'edit');
  assert.equal(policy.readOnlyToolName('mcp__fs__read_file'), true);
  assert.equal(policy.readOnlyToolName('mcp__fs__read_and_copy'), false);
  assert.equal(policy.readOnlyToolName('fs_moveFile'), false);
  assert.equal(policy.readOnlyToolName('do_thing'), false);
});
