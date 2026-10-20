'use strict';

// zn-gate check: Codex skips a hook until the user approves it in /hooks (and again after a change), so a hook that
// works is not yet protection. Every folder here is made up in a temporary directory; the real Codex folder is never read.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { check, report } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');
const { trustCodexHooks } = require('./helpers/codex_trust');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

function codexHome(t) {
  const home = tempDir(t, 'zn-check-trust-');
  const env = { HOME: home, PATH: process.env.PATH };
  const install = getAdapter('codex').install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  const file = getAdapter('codex').hooksFile({ home, env });
  return { home, env, install, cwd: tempDir(t, 'zn-check-trust-cwd-'), file, config: path.join(path.dirname(file), 'config.toml') };
}

const codexResult = async (ctx) => (await check({ home: ctx.home, env: ctx.env, cwd: ctx.cwd })).results.find((r) => r.id === 'codex');
const textOf = (res) => { let s = ''; const code = report(res, (x) => { s += x; }); return { s, code }; };

test('check: hooks Codex has not been asked about are not protected, with the next step', async (t) => {
  const ctx = codexHome(t);
  const r = await codexResult(ctx);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /Codex skips new hooks until you approve them in `\/hooks`, so zn does not protect Codex yet/);
  assert.equal(r.fix, 'open Codex and approve zn\'s hooks with `/hooks`, then run `zn-gate check` again');
  const { s, code } = textOf({ results: [r], removed: true });
  assert.match(s, /X  Codex CLI\s+NOT protected: .*approve them in `\/hooks`/);
  assert.match(s, /To fix it, open Codex and approve zn's hooks with `\/hooks`/);
  assert.doesNotMatch(s, /OK Codex/);
  assert.equal(code, 1);
});

test('check: hooks approved with the matching hash are protected', async (t) => {
  const ctx = codexHome(t);
  trustCodexHooks(ctx.file);
  const r = await codexResult(ctx);
  assert.equal(r.state, 'protected', r.problem);
  assert.equal(textOf({ results: [r], removed: true }).code, 0);
});

test('check: a hook that changed after it was approved is not protected', async (t) => {
  const ctx = codexHome(t);
  trustCodexHooks(ctx.file);
  const tree = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
  tree.hooks.PreToolUse[tree.hooks.PreToolUse.length - 1].hooks[0].timeout = 31;
  fs.writeFileSync(ctx.file, JSON.stringify(tree));
  const r = await codexResult(ctx);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /zn's PreToolUse hook changed after you approved it in Codex, so Codex skips it until you approve it again/);
  assert.match(r.fix, /approve zn's hooks with `\/hooks`/);
});

test('check: one hook of zn without approval is enough to be not protected', async (t) => {
  const ctx = codexHome(t);
  trustCodexHooks(ctx.file);
  const text = fs.readFileSync(ctx.config, 'utf8');
  // Drop the approval of the last hook only.
  const at = text.lastIndexOf('\n[hooks.state.');
  fs.writeFileSync(ctx.config, text.slice(0, at) + '\n');
  const r = await codexResult(ctx);
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /approve them in `\/hooks`/);
});

test('check: an approval that cannot be read is "waiting for approval", never OK', async (t) => {
  const ctx = codexHome(t);
  fs.writeFileSync(ctx.config, 'this is = = not toml [[');
  const r = await codexResult(ctx);
  assert.equal(r.state, 'awaiting-approval');
  assert.equal(r.problem || '', '');
  const { s, code } = textOf({ results: [r], removed: true });
  assert.match(s, /\?  Codex CLI\s+installed, waiting for your approval in Codex \(\/hooks\)/);
  assert.match(s, /To finish, open Codex and approve zn's hooks with `\/hooks`/);
  assert.doesNotMatch(s, /OK Codex/);
  assert.doesNotMatch(s, /Your agent cannot read secret files/);
  assert.equal(code, 1);
});

test('check: zn hooks that Codex does not run from a project folder or a managed file are not asked to be approved', async (t) => {
  const home = tempDir(t, 'zn-check-trust-proj-');
  const proj = tempDir(t, 'zn-check-trust-projdir-');
  getAdapter('codex').install({ scope: 'project', projectDir: proj, home, env: { HOME: home }, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  const r = (await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: proj })).results.find((x) => x.id === 'codex');
  assert.notEqual(r.state, 'awaiting-approval');
  assert.ok(!r.approval);
});

test('zn hooks install codex says that Codex must approve the hooks before zn protects it', (t) => {
  const ctx = codexHome(t);
  assert.ok(ctx.install.warnings.some((w) => /zn does not protect Codex yet: Codex runs new or changed hooks only after you approve them.*\/hooks/.test(w)), JSON.stringify(ctx.install.warnings));
});
