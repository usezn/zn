'use strict';

// zn-gate check: another tool's Codex hook that runs before a call or an approval can change a call after
// zn has checked it, so Codex is reported as not fully protected. All configs here are made up.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { check } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

const { trustCodexHooks } = require('./helpers/codex_trust');

function codexHome(t) {
  const home = tempDir(t, 'zn-check-other-hooks-');
  const env = { HOME: home, PATH: process.env.PATH };
  getAdapter('codex').install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  trustCodexHooks(getAdapter('codex').hooksFile({ home, env }));
  return { home, env, cwd: tempDir(t, 'zn-check-other-hooks-cwd-'), file: getAdapter('codex').hooksFile({ home, env }) };
}

const codexResult = async (ctx) => (await check({ home: ctx.home, env: ctx.env, cwd: ctx.cwd })).results.find((r) => r.id === 'codex');
const other = (event, extra = {}, matcher = '^Bash$') => ({ matcher, hooks: [{ type: 'command', command: 'node /opt/example/audit-hook.js', ...extra }] });

function addToHooksJson(ctx, event, group) {
  const tree = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
  tree.hooks[event] = (tree.hooks[event] || []).concat([group]);
  fs.writeFileSync(ctx.file, JSON.stringify(tree));
}

test('check: only zn hooks in Codex is protected', async (t) => {
  assert.equal((await codexResult(codexHome(t))).state, 'protected');
});

test('check: another PreToolUse hook in hooks.json is not fully protected', async (t) => {
  const ctx = codexHome(t);
  addToHooksJson(ctx, 'PreToolUse', other('PreToolUse'));
  const r = await codexResult(ctx);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /another hook runs before Codex calls \(PreToolUse in .*hooks\.json\).*can change a call after zn has checked it/);
  assert.match(r.fix, /review that hook/);
});

test('check: another PermissionRequest hook is reported too', async (t) => {
  const ctx = codexHome(t);
  addToHooksJson(ctx, 'PermissionRequest', other('PermissionRequest'));
  const r = await codexResult(ctx);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /PermissionRequest in/);
});

test('check: a hook with no matcher counts, a hook for a tool zn does not match does not', async (t) => {
  const a = codexHome(t);
  addToHooksJson(a, 'PreToolUse', { hooks: [{ type: 'command', command: 'node /opt/example/audit-hook.js' }] });
  assert.equal((await codexResult(a)).state, 'not-protected');
  const b = codexHome(t);
  addToHooksJson(b, 'PreToolUse', other('PreToolUse', {}, 'WebSearch'));
  assert.equal((await codexResult(b)).state, 'protected');
});

test('check: a background hook, a hook for another event, and a second zn entry are fine', async (t) => {
  const ctx = codexHome(t);
  addToHooksJson(ctx, 'PreToolUse', other('PreToolUse', { async: true }));
  addToHooksJson(ctx, 'PostToolUse', other('PostToolUse'));
  addToHooksJson(ctx, 'SessionStart', other('SessionStart', {}, ''));
  assert.equal((await codexResult(ctx)).state, 'protected');
});

test('check: another hook declared in config.toml is not fully protected', async (t) => {
  const ctx = codexHome(t);
  fs.writeFileSync(path.join(path.dirname(ctx.file), 'config.toml'),
    '[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "node /opt/example/audit-hook.js"\n');
  trustCodexHooks(ctx.file);
  const r = await codexResult(ctx);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /PreToolUse in .*config\.toml/);
});

test('check: another hook in the project .codex folder is reported', async (t) => {
  const ctx = codexHome(t);
  fs.mkdirSync(path.join(ctx.cwd, '.codex'));
  fs.writeFileSync(path.join(ctx.cwd, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [other('PreToolUse')] } }));
  const r = await codexResult(ctx);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /\.codex.hooks\.json/);
});

test('check: unreadable or malformed hook files say nothing', async (t) => {
  const ctx = codexHome(t);
  fs.writeFileSync(path.join(path.dirname(ctx.file), 'config.toml'), 'this is = = not toml [[');
  // zn cannot read whether Codex approved the hooks: it says "waiting for approval", never protected.
  assert.equal((await codexResult(ctx)).state, 'awaiting-approval');
});
