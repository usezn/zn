'use strict';

// zn-gate check: a Codex hook with `async` set runs in the background and cannot block anything,
// so zn's hook set that way is reported as not protecting Codex.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { check } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

function codexHome(t) {
  const home = tempDir(t, 'zn-check-async-');
  const env = { HOME: home, PATH: process.env.PATH };
  getAdapter('codex').install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  return { home, env, cwd: tempDir(t, 'zn-check-async-cwd-'), file: getAdapter('codex').hooksFile({ home, env }) };
}

const codexResult = async (ctx) => (await check({ home: ctx.home, env: ctx.env, cwd: ctx.cwd })).results.find((r) => r.id === 'codex');

test('check: zn hooks that are not in the background are protected', async (t) => {
  const r = await codexResult(codexHome(t));
  assert.equal(r.state, 'protected');
});

test('check: a zn hook with async true in hooks.json is not protected', async (t) => {
  const ctx = codexHome(t);
  const tree = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
  const group = tree.hooks.PreToolUse[0];
  (group.hooks || [group])[0].async = true;
  fs.writeFileSync(ctx.file, JSON.stringify(tree));
  const r = await codexResult(ctx);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /PreToolUse hook runs in the background \(async\) in .*hooks\.json, and a background hook cannot block anything/);
  assert.match(r.fix, /remove `async`/);
});

test('check: async false and another command with async true are fine', async (t) => {
  const ctx = codexHome(t);
  const tree = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
  const group = tree.hooks.PreToolUse[0];
  (group.hooks || [group])[0].async = false;
  tree.hooks.PostToolUse = (tree.hooks.PostToolUse || []).concat([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo audit-log', async: true }] }]);
  fs.writeFileSync(ctx.file, JSON.stringify(tree));
  assert.equal((await codexResult(ctx)).state, 'protected');
});

test('check: a zn hook with async = true in config.toml is not protected', async (t) => {
  const ctx = codexHome(t);
  const tree = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
  const group = tree.hooks.PreToolUse[0];
  const command = (group.hooks || [group])[0].command;
  fs.writeFileSync(path.join(path.dirname(ctx.file), 'config.toml'),
    '[[hooks.PostToolUse]]\nmatcher = "Bash"\n\n[[hooks.PostToolUse.hooks]]\ntype = "command"\ncommand = ' + JSON.stringify(command) + '\nasync = true\ntimeout = 120\n');
  const r = await codexResult(ctx);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /PostToolUse hook runs in the background \(async\) in .*config\.toml/);
});
