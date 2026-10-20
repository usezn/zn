'use strict';

// zn-gate check: a Codex setting that switches zn's hooks off is reported as not protecting Codex.
// Every config here is made up in a temporary folder; the real Codex folder is never read.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { check } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

const { trustCodexHooks, trustToml } = require('./helpers/codex_trust');

function codexHome(t) {
  const home = tempDir(t, 'zn-check-state-');
  const env = { HOME: home, PATH: process.env.PATH };
  getAdapter('codex').install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  trustCodexHooks(getAdapter('codex').hooksFile({ home, env }));
  const file = getAdapter('codex').hooksFile({ home, env });
  return { home, env, cwd: tempDir(t, 'zn-check-state-cwd-'), file, config: path.join(path.dirname(file), 'config.toml') };
}

const codexResult = async (ctx) => (await check({ home: ctx.home, env: ctx.env, cwd: ctx.cwd })).results.find((r) => r.id === 'codex');
const tomlKey = (s) => JSON.stringify(s);

test('check: a hook switched off in hooks.state is not protected', async (t) => {
  const ctx = codexHome(t);
  fs.writeFileSync(ctx.config, '[hooks.state.' + tomlKey(ctx.file + ':pre_tool_use:0:0') + ']\nenabled = false\n');
  const r = await codexResult(ctx);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /PreToolUse hook is switched off in .*config\.toml \(\[hooks\.state\] enabled = false\)/);
  assert.match(r.fix, /delete that \[hooks\.state\] entry/);
});

test('check: hooks.state with enabled true, or with the trusted hash, is fine', async (t) => {
  const ctx = codexHome(t);
  const trusted = trustToml(ctx.file);
  fs.writeFileSync(ctx.config, trusted +
    '\n[hooks.state.' + tomlKey(ctx.file + ':pre_tool_use:0:0') + '.x]\nenabled = false\n');
  assert.equal((await codexResult(ctx)).state, 'protected');
  fs.writeFileSync(ctx.config, trusted.replace('trusted_hash', 'enabled = true\ntrusted_hash'));
  assert.equal((await codexResult(ctx)).state, 'protected');
});

test('check: switching off a hook that is not zn\'s, or in another file, is fine', async (t) => {
  const ctx = codexHome(t);
  const tree = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
  tree.hooks.PostToolUse = (tree.hooks.PostToolUse || []).concat([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo audit-log' }] }]);
  fs.writeFileSync(ctx.file, JSON.stringify(tree));
  const other = tree.hooks.PostToolUse.length - 1;
  fs.writeFileSync(ctx.config, trustToml(ctx.file) + '\n' +
    '[hooks.state.' + tomlKey(ctx.file + ':post_tool_use:' + other + ':0') + ']\nenabled = false\n\n' +
    '[hooks.state.' + tomlKey(path.join(ctx.home, 'elsewhere', 'hooks.json') + ':pre_tool_use:0:0') + ']\nenabled = false\n');
  assert.equal((await codexResult(ctx)).state, 'protected');
});

test('check: [features] hooks = false in config.toml is not protected', async (t) => {
  const ctx = codexHome(t);
  fs.writeFileSync(ctx.config, '[features]\nhooks = false\n');
  const r = await codexResult(ctx);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /turns hooks off \(\[features\] hooks = false\)/);
});
