'use strict';
// The limits on how deep (MAX_NEST_DEPTH) and how large (MAX_NEST_NODES) the arguments of a tool zn does not know may be. A call
// exactly at a limit is read as designed; one past it cannot be read in full and is refused (fail closed). Where each cap is enforced:
//  - the path scan of Gemini CLI and Antigravity (pathsOf): depth and nodes, for every tool;
//  - the path scan of GitHub Copilot CLI (pathsOf, loose = a tool it does not know): depth and nodes; and its command scan
//    (commandScan): depth and nodes, counting a list as a node too;
//  - the path scan of an unknown tool of Claude Code (pathsOf with { loose: true, nodeCap: false }): depth only, it has no node cap and reads every node;
//  - the text scan of the hooks runner (writtenTextsOf): depth only.
// Fixtures are inert text.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runner = require('../lib/hooks/runner');
const claude = require('../lib/agents/claude-code');
const gemini = require('../lib/agents/gemini');
const antigravity = require('../lib/agents/antigravity');
const copilot = require('../lib/agents/copilot');
const { MAX_NEST_DEPTH, MAX_NEST_NODES } = require('../lib/nest-limits');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
const nest = (levels, leaf) => levels.reduceRight((acc, k) => ({ [k]: acc }), leaf);
// An object with a path and `n` small objects: it holds n + 1 objects in all (the node count of every scan).
const flat = (n, target, last) => {
  const o = { path: target, content: 'x' };
  for (let i = 0; i < n; i++) o['k' + i] = i === n - 1 && last ? last : { x: 1 };
  return o;
};
// The same object with an edit in place of the body (the same number of objects): an edit zn applies to the file on disk. A body sent
// to a tool zn does not know is refused for a .env, so the harmless case of a found dotenv path is an edit.
const flatEdit = (n, target) => {
  const o = flat(n, target);
  delete o.content;
  o.old_string = 'FOO=1';
  o.new_string = 'FOO=2';
  return o;
};

function project(t) {
  const dir = tempDir(t, 'zn-nest-');
  fs.writeFileSync(path.join(dir, '.env'), 'FOO=1');
  return dir;
}

async function refused(adapter, raw) {
  const res = await runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });
  return res.decision.decision === 'deny' || Boolean(res.output && (res.output.decision === 'deny' || res.output.permissionDecision === 'deny'));
}

test('node limit in the path scans: exactly MAX_NEST_NODES objects is read, one more is refused', () => {
  assert.equal(MAX_NEST_NODES, 500);
  for (const [id, pathsOf] of [['gemini', gemini.pathsOf], ['antigravity', antigravity.pathsOf], ['copilot loose', (a) => copilot.pathsOf(a, { loose: true })]]) {
    assert.equal(pathsOf(flat(MAX_NEST_NODES - 1, 'notes.txt')).bad, false, id + ' at the limit');
    assert.equal(pathsOf(flat(MAX_NEST_NODES, 'notes.txt')).bad, true, id + ' one past the limit');
  }
  // Copilot's path scan counts nodes only for a tool it does not know.
  assert.equal(copilot.pathsOf(flat(MAX_NEST_NODES + 100, 'notes.txt')).bad, false);
});

test('node and depth limits of the Copilot command scan: a list counts as a node, a level past MAX_NEST_DEPTH is truncated', () => {
  assert.equal(copilot.commandScan(flat(MAX_NEST_NODES - 1, 'notes.txt'), '/w').truncated, false);
  assert.equal(copilot.commandScan(flat(MAX_NEST_NODES, 'notes.txt'), '/w').truncated, true);
  assert.equal(copilot.commandScan({ items: Array.from({ length: MAX_NEST_NODES - 2 }, () => ({ x: 1 })) }, '/w').truncated, false);
  assert.equal(copilot.commandScan({ items: Array.from({ length: MAX_NEST_NODES - 1 }, () => ({ x: 1 })) }, '/w').truncated, true);
  assert.equal(copilot.commandScan(nest(names.slice(0, MAX_NEST_DEPTH), { x: 1 }), '/w').truncated, false);
  assert.equal(copilot.commandScan(nest(names.slice(0, MAX_NEST_DEPTH + 1), { x: 1 }), '/w').truncated, true);
});

test('depth limit in the path scans: an object at depth MAX_NEST_DEPTH is read, one level deeper sets bad', () => {
  for (const [id, pathsOf] of [['gemini', gemini.pathsOf], ['antigravity', antigravity.pathsOf], ['copilot', copilot.pathsOf], ['copilot loose', (a) => copilot.pathsOf(a, { loose: true })]]) {
    const at = pathsOf(nest(names.slice(0, MAX_NEST_DEPTH), { path: 'notes.txt' }));
    assert.equal(at.bad, false, id + ' at the limit');
    assert.deepEqual(at.paths, ['notes.txt'], id + ' finds the path at the limit');
    assert.equal(pathsOf(nest(names.slice(0, MAX_NEST_DEPTH + 1), { path: 'notes.txt' })).bad, true, id + ' one past the limit');
  }
});

test('decisions at the node limit: Gemini CLI, Antigravity and Copilot CLI read MAX_NEST_NODES objects and refuse one more', async (t) => {
  const dir = project(t);
  const other = path.join(dir, 'notes.txt');
  const env = path.join(dir, '.env');
  const shapes = {
    gemini: [gemini, (a) => ({ session_id: 's', cwd: dir, hook_event_name: 'BeforeTool', tool_name: 'files_helper', tool_input: a })],
    antigravity: [antigravity, (a) => ({ conversationId: 'c1', workspacePaths: [dir], toolCall: { name: 'files_helper', args: a } })],
    copilot: [copilot, (a) => ({ sessionId: 's1', timestamp: 1792400000000, cwd: dir, toolName: 'files_helper', toolArgs: JSON.stringify(a) })],
  };
  for (const [id, [adapter, shape]] of Object.entries(shapes)) {
    assert.equal(await refused(adapter, shape(flat(MAX_NEST_NODES - 1, other))), false, id + ' other at the limit');
    assert.equal(await refused(adapter, shape(flat(MAX_NEST_NODES, other))), true, id + ' other one past the limit');
    assert.equal(await refused(adapter, shape(flat(MAX_NEST_NODES, env))), true, id + ' env one past the limit');
    // A dotenv path inside the limit is found; the tool is not one of the agent's own, so even a harmless edit is refused.
    assert.equal(await refused(adapter, shape(flatEdit(MAX_NEST_NODES - 1, env))), true, id + ' env at the limit');
  }
});

test('Claude Code unknown tool: no node cap, every node is read, so a dotenv path in the last of many objects is still found', async (t) => {
  const dir = project(t);
  const other = path.join(dir, 'notes.txt');
  const env = path.join(dir, '.env');
  const call = (a) => ({ session_id: 's', cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'files_helper', tool_input: a, tool_use_id: 't' });
  assert.equal(await refused(claude, call(flat(MAX_NEST_NODES - 1, other))), false);
  assert.equal(await refused(claude, call(flat(MAX_NEST_NODES + 100, other))), false);
  // The path sits in the last object, past MAX_NEST_NODES, and the content sets a hook-stopping variable.
  const last = { path: env, content: 'LD_DEBUG=help' };
  assert.equal(await refused(claude, call(flat(MAX_NEST_NODES + 100, other, last))), true);
});

test('Claude Code unknown tool: a dotenv path at depth MAX_NEST_DEPTH is read, one level deeper is refused', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  const other = path.join(dir, 'notes.txt');
  const call = (levels, target, leaf) => ({ session_id: 's', cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'files_helper', tool_input: nest(names.slice(0, levels), leaf || { path: target, content: 'x' }), tool_use_id: 't' });
  assert.equal(await refused(claude, call(MAX_NEST_DEPTH, other)), false, 'other at the limit');
  // The dotenv path is found at the limit, but the text next to it sits too deep for the text scan: refused as unreadable.
  assert.equal(await refused(claude, call(MAX_NEST_DEPTH, env)), true, 'env at the limit: found, text unreadable');
  // At depth 1 the path and an edit next to it are read, but the tool is not one of the agent's own: refused even for a harmless edit.
  assert.equal(await refused(claude, call(1, env, { path: env, old_string: 'FOO=1', new_string: 'FOO=2' })), true, 'env at depth 1: unknown tool edit');
  // A body next to it is refused: zn does not know whether this tool writes it as the whole file.
  assert.equal(await refused(claude, call(1, env)), true, 'env at depth 1: body sent to an unknown tool');
  assert.equal(await refused(claude, call(MAX_NEST_DEPTH + 1, other)), true, 'other past the limit');
  assert.equal(await refused(claude, call(MAX_NEST_DEPTH + 1, env)), true, 'env past the limit');
});

test('runner text scan: the text next to a dotenv path is read down to a depth and refused beyond it, never skipped', async (t) => {
  const dir = project(t);
  const env = path.join(dir, '.env');
  const decide = async (levels) => {
    const raw = { session_id: 's', cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'files_helper', tool_input: { path: env, extra: nest(names.slice(0, levels), { content: 'LD_DEBUG=help' }) }, tool_use_id: 't' };
    return (await runner.handle(claude, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open' })).decision;
  };
  // Within the limit the text is read and named; one level short of the limit it is unresolved (refused as unreadable); at and past
  // the limit the path scan itself cannot read the arguments.
  for (let levels = 1; levels <= MAX_NEST_DEPTH + 2; levels++) {
    const d = await decide(levels);
    assert.equal(d.decision, 'deny', 'levels ' + levels);
    if (levels <= MAX_NEST_DEPTH - 2) assert.match(d.message, /would set LD_DEBUG for the agent/, 'levels ' + levels);
    else if (levels === MAX_NEST_DEPTH - 1) assert.match(d.message, /is a file the agent loads into/, 'levels ' + levels);
    else assert.match(d.message, /could not read the file names/, 'levels ' + levels);
  }
});
