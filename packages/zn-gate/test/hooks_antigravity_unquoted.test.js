'use strict';
process.env.ZN_STATS = 'off';
// Antigravity runs a hook command split on spaces with no shell: the launcher path must not be quoted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getAdapter } = require('../lib/agents');
const { check, report } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const agy = getAdapter('antigravity');
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const skip = { skip: process.platform === 'win32' };
const hooksPath = (home) => path.join(home, '.gemini', 'config', 'hooks.json');
const cmdOf = (home) => JSON.parse(fs.readFileSync(hooksPath(home), 'utf8'))['zn-gate'].PreToolUse[0].hooks[0].command;
const quote = (c) => c.replace(/^(\S+) (\w+)$/, "'$1' $2");
function setup(t) {
  const home = tempDir(t, 'zn-agy-q-');
  agy.install({ scope: 'user', home, nodePath: process.execPath, runnerPath: RUNNER });
  return home;
}
const naive = (command, input) => {
  const parts = command.split(' ');
  return spawnSync(parts[0], parts.slice(1), { input, encoding: 'utf8' });
};

test('antigravity user install: the launcher command has no quotes', skip, (t) => {
  const home = setup(t);
  assert.match(cmdOf(home), /^[^'"\s]+\/zn-hook-antigravity\.sh PreToolUse$/);
});

test('antigravity user install: the command runs when split on spaces with no shell', skip, (t) => {
  const home = setup(t);
  const r = naive(cmdOf(home), JSON.stringify({ conversationId: 'c', workspacePaths: [home], toolCall: { name: 'list_dir', args: { DirectoryPath: home } } }));
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).decision, 'allow');
});

test('antigravity check fails on the old quoted form and passes on the new one', skip, async (t) => {
  const home = setup(t);
  const env = { HOME: home, PATH: process.env.PATH };
  const cwd = tempDir(t, 'zn-agy-cwd-');
  let res = await check({ home, env, cwd, nodeVersion: '22.0.0' });
  const ok = res.results.find((r) => r.id === 'antigravity');
  assert.equal(ok.state, 'protected', ok.problem);
  assert.equal(ok.verified, true);
  const file = hooksPath(home);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const h = data['zn-gate'].PreToolUse[0].hooks[0];
  h.command = quote(h.command);
  fs.writeFileSync(file, JSON.stringify(data));
  res = await check({ home, env, cwd, nodeVersion: '22.0.0' });
  const bad = res.results.find((r) => r.id === 'antigravity');
  assert.equal(bad.state, 'not-protected');
  assert.match(bad.problem, /without a shell/);
  let s = '';
  report(res, (x) => { s += x; });
  assert.match(s, /zn hooks install antigravity/);
});

test('antigravity uninstall removes the old quoted entry and the new unquoted one', skip, (t) => {
  const home = setup(t);
  const file = hooksPath(home);
  const unq = cmdOf(home);
  agy.uninstall({ scope: 'user', home });
  assert.equal(fs.existsSync(file), false);
  for (const command of [unq, quote(unq)]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ 'zn-gate': { enabled: true, PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } }));
    assert.equal(agy.uninstall({ scope: 'user', home }).removed, 1);
    assert.equal(fs.existsSync(file), false);
  }
});

test('antigravity install re-run replaces an old quoted entry', skip, (t) => {
  const home = setup(t);
  const file = hooksPath(home);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const h = data['zn-gate'].PreToolUse[0].hooks[0];
  h.command = quote(h.command);
  fs.writeFileSync(file, JSON.stringify(data));
  agy.install({ scope: 'user', home, nodePath: process.execPath, runnerPath: RUNNER });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['zn-gate']);
  assert.doesNotMatch(cmdOf(home), /'/);
});
