'use strict';

// zn-gate check in a temporary HOME: the exit code and the output lines for a clean, a half set-up and a fully
// set-up machine.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { check: realCheck, report } = require('../lib/check');
const check = (opts) => realCheck({ nodeVersion: '22.0.0', ...opts });
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

function machine(t, installed, found = []) {
  const home = tempDir(t, 'zn-exit-home-');
  const bin = tempDir(t, 'zn-exit-bin-');
  const env = { HOME: home, PATH: bin };
  for (const id of installed) {
    getAdapter(id).install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  }
  for (const dir of found) fs.mkdirSync(path.join(home, dir), { recursive: true });
  return { home, env, cwd: tempDir(t, 'zn-exit-cwd-') };
}

async function run(ctx) {
  const res = await check(ctx);
  let out = '';
  const code = report(res, (x) => { out += x; });
  return { res, out, code };
}

test('check report: a clean machine exits 1, finds no agent and deletes its test folder', async (t) => {
  const { out, code } = await run(machine(t, []));
  assert.equal(code, 1);
  assert.match(out, /^\nzn-gate check: does zn stop your coding agent from reading a secret\?\n/);
  assert.match(out, /Claude Code\s+not found on this machine\n/);
  assert.match(out, /Codex CLI\s+not found on this machine\n/);
  assert.match(out, /No supported coding agent was found on this machine/);
  assert.doesNotMatch(out, /\bOK\b|NOT protected/);
  assert.match(out, /The test folder was deleted\.\n$/);
});

test('check report: agents found but none set up exit 1 and point to init', async (t) => {
  const { out, code } = await run(machine(t, [], ['.claude', '.codex']));
  assert.equal(code, 1);
  assert.match(out, /Codex CLI\s+zn is not set up for this agent/);
  assert.match(out, /zn is not set up for your agents yet, so nothing protects your secrets\. To set it up, run `npx -y zn-gate init`/);
  assert.doesNotMatch(out, /Your agent cannot read secret files/);
});

test('check report: a half set-up machine with one protected agent exits 0 and names the others together', async (t) => {
  const { res, out, code } = await run(machine(t, ['codex'], ['.claude', '.cursor']));
  assert.equal(res.results.find((r) => r.id === 'codex').state, 'protected');
  assert.equal(code, 0);
  assert.match(out, /OK Codex CLI\s+blocked the \.env file and allowed the ordinary file\. Your agent would be told:\n {5}"/);
  assert.match(out, /Your agent cannot read secret files such as \.env through these tools\. Nothing was sent anywhere\./);
  assert.match(out, /Not set up yet: Claude Code, Cursor\. To add them, run `npx -y zn-gate init`/);
  assert.doesNotMatch(out, /NOT protected/);
});

test('check report: a half set-up machine with a broken hook exits 1 even though another agent is protected', async (t) => {
  const ctx = machine(t, ['codex', 'cursor']);
  const file = getAdapter('cursor').hooksFile(ctx);
  const tree = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const list of Object.values(tree.hooks)) for (const h of list) h.command = 'zn hook cursor';
  fs.writeFileSync(file, JSON.stringify(tree));
  const { out, code } = await run(ctx);
  assert.equal(code, 1);
  assert.match(out, /OK Codex CLI/);
  assert.match(out, /X {2}Cursor\s+NOT protected: .*no `zn` on your PATH.*\.\n {5}To fix it, /);
  assert.match(out, /Some agents are not protected \(see above\)\./);
  assert.doesNotMatch(out, /Your agent cannot read secret files/);
});

test('check report: a fully set-up machine exits 0 with an OK line per agent and no missing-agent line', async (t) => {
  const { res, out, code } = await run(machine(t, ['claude-code', 'codex', 'cursor', 'opencode']));
  assert.equal(code, 0);
  for (const id of ['claude-code', 'codex', 'cursor', 'opencode']) {
    assert.equal(res.results.find((r) => r.id === id).state, 'protected', id);
  }
  assert.equal((out.match(/^ {2}OK /gm) || []).length, 4);
  assert.match(out, /Your agent cannot read secret files such as \.env through these tools\./);
  assert.match(out, /zn env shadow \.env/);
  assert.doesNotMatch(out, /Not set up yet|NOT protected/);
  assert.match(out, /The test folder was deleted\.\n$/);
});
