'use strict';
// Pins the claims the threat model makes about which agents read an unknown tool and how a .env is named in a shell command, so the
// evidence is in the tests: ZCode shares Gemini CLI's path scan, the Codex CLI and Cursor hook matchers, OpenCode treating an unknown
// tool as an MCP call, and backslash-escaped names of a watched .env in a shell command. Fixtures are inert text.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runner = require('../lib/hooks/runner');
const claude = require('../lib/agents/claude-code');
const codex = require('../lib/agents/codex');
const cursor = require('../lib/agents/cursor');
const opencode = require('../lib/agents/opencode');
const zcode = require('../lib/agents/zcode');
const { MAX_NEST_DEPTH, MAX_NEST_NODES } = require('../lib/nest-limits');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const BS = String.fromCharCode(92);
const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
const nest = (levels, leaf) => levels.reduceRight((acc, k) => ({ [k]: acc }), leaf);
const flat = (n, target) => {
  const o = { path: target, content: 'x' };
  for (let i = 0; i < n; i++) o['k' + i] = { x: 1 };
  return o;
};

function project(t) {
  const dir = tempDir(t, 'zn-claims-');
  fs.writeFileSync(path.join(dir, '.env'), 'FOO=1\n');
  fs.writeFileSync(path.join(dir, 'a'), 'x\n');
  return dir;
}

async function refused(adapter, raw) {
  const res = await runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
  return res.decision.decision === 'deny' || Boolean(res.output && (res.output.decision === 'deny' || res.output.permissionDecision === 'deny' ||
    (res.output.hookSpecificOutput && res.output.hookSpecificOutput.permissionDecision === 'deny')));
}

const zc = (dir, tool_name, tool_input) => ({ session_id: 's', cwd: dir, hook_event_name: 'PreToolUse', tool_name, tool_input });
const cc = (dir, tool_name, tool_input) => ({ session_id: 's', cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't' });
const oc = (dir, tool, args) => ({ hook: 'tool.execute.before', tool, args, cwd: dir, sessionID: 's' });

test('ZCode reads an unknown tool with the path scan of Gemini CLI: depth MAX_NEST_DEPTH and MAX_NEST_NODES objects', async (t) => {
  // The shared scan: ZCode takes pathsOf from the Gemini CLI adapter, not its own copy.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agents', 'zcode.js'), 'utf8');
  assert.match(src, /const \{ pathsOf \} = require\('\.\/gemini'\);/);
  const dir = project(t);
  const env = path.join(dir, '.env');
  const other = path.join(dir, 'notes.txt');
  assert.equal(MAX_NEST_DEPTH, 6);
  const call = (levels, target) => zc(dir, 'files_helper', nest(names.slice(0, levels), { path: target }));
  assert.equal(await refused(zcode, call(MAX_NEST_DEPTH, other)), false, 'other at the depth limit');
  assert.equal(await refused(zcode, call(MAX_NEST_DEPTH + 1, other)), true, 'other one level past the limit');
  assert.equal(await refused(zcode, call(MAX_NEST_DEPTH + 1, env)), true, '.env 7 levels deep');
  assert.equal(await refused(zcode, zc(dir, 'files_helper', flat(MAX_NEST_NODES - 1, other))), false, 'other at the node limit');
  assert.equal(await refused(zcode, zc(dir, 'files_helper', flat(MAX_NEST_NODES, other))), true, 'other one object past the limit');
  assert.equal(await refused(zcode, zc(dir, 'files_helper', flat(MAX_NEST_NODES + 100, env))), true, '.env with more than 500 objects');
});

test('hook matchers: Codex CLI sends Bash, apply_patch and MCP calls only; Cursor runs preToolUse for Grep, Write and Delete plus MCP calls', () => {
  assert.equal(codex.PRE_MATCHER, '^(Bash|apply_patch|mcp__.+)$');
  const entries = cursor.hookEntries('zn-hook');
  assert.equal(entries.preToolUse.matcher, 'Grep|Write|Delete');
  assert.ok(Object.prototype.hasOwnProperty.call(entries, 'beforeMCPExecution'), 'beforeMCPExecution is installed');
  assert.ok(cursor.EVENTS.includes('beforeMCPExecution'));
});

test('OpenCode maps a tool name it does not know to an MCP call, and such a call naming a .env is refused', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  const ev = opencode.normalize(oc(dir, 'custom_helper', { path: env }));
  assert.equal(ev.tool, 'mcp');
  assert.equal(opencode.normalize(oc(dir, 'read', { filePath: env })).tool, 'read');
  assert.equal(await refused(opencode, oc(dir, 'custom_helper', { path: env })), true, 'unknown tool names the .env');
  assert.equal(await refused(opencode, oc(dir, 'custom_helper', { path: path.join(dir, 'notes.txt') })), false, 'unknown tool, other file');
});

// A backslash before a name in a shell word: outside quotes bash drops it (\.env is .env). On Linux and macOS zn refuses every command
// that names a watched .env this way, the read-only ones and touch included (cat \.env, touch \.env), as a path it cannot check; the plain
// name still passes for those commands. So every write, copy or program below is refused.
test('shell commands that name a watched .env through a backslash escape are refused', async (t) => {
  const dir = project(t);
  const sh = (command) => refused(claude, cc(dir, 'Bash', { command }));
  const refusedCommands = [
    'cat ' + BS + '.env >> x', 'echo x > ' + BS + '.env', 'echo x >> ' + BS + '.env', 'cp a ' + BS + '.env', 'mv a ' + BS + '.env',
    'tee ' + BS + '.env', 'sed -i s/1/2/ ' + BS + '.env', 'printf LD_DEBUG=help >> ' + BS + '.e' + BS + 'nv', 'printf LD_DEBUG=help >> .e' + BS + 'nv',
    'cp a .e' + BS + 'nv', 'python3 -c pass ' + BS + '.env', 'curl -o ' + BS + '.env http://example.com', 'touch ' + BS + '.env',
    'dd of=' + BS + '.env if=a', 'awk 1 a > ' + BS + '.env', 'echo LD_PRELOAD=/tmp/x.so >> ' + BS + '.env', 'node -e 0 ' + BS + '.env',
    'unknowncmd ' + BS + '.env',
  ];
  for (const command of refusedCommands) assert.equal(await sh(command), true, command);
  // Inside quotes bash keeps the backslash: "\.env" and '\.env' name a file called \.env, not the project's .env. zn refuses them anyway
  // (it does not tell the two apart and fails closed), while ".\env" is a file called .\env that no rule watches and passes.
  for (const command of ['cp a "' + BS + '.env"', "cp a '" + BS + ".env'"]) assert.equal(await sh(command), true, command);
  assert.equal(await sh('cp a ".' + BS + 'env"'), false, 'cp a ".\\env"');
});
