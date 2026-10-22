'use strict';

// zn-gate check: hooks written by an older zn-gate still work, so the agent stays protected, but check says
// they are old: they run Node.js directly (the current install writes the launcher script) or lack events
// the current install adds.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { check: realCheck } = require('../lib/check');
const check = (opts) => realCheck({ nodeVersion: '22.0.0', ...opts });
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const STALE = /installed by an older zn-gate/;

function install(t, id) {
  const home = tempDir(t, 'zn-check-stale-home-');
  const env = { HOME: home, PATH: process.env.PATH };
  const adapter = getAdapter(id);
  adapter.install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  const file = id === 'claude-code' ? adapter.settingsFile({ home, env }) : adapter.hooksFile({ home, env });
  return { home, env, cwd: tempDir(t, 'zn-check-stale-cwd-'), file };
}

// Rewrites the file as an older zn-gate did: the Node.js and the runner called directly, and only some events.
function makeOld(ctx, id, { direct = true, drop = [] } = {}) {
  const tree = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
  for (const ev of drop) delete tree.hooks[ev];
  if (direct) {
    for (const groups of Object.values(tree.hooks)) {
      for (const g of groups) for (const h of g.hooks || []) h.command = "'" + process.execPath + "' '" + RUNNER + "' " + id;
    }
  }
  fs.writeFileSync(ctx.file, JSON.stringify(tree, null, 2));
}

const result = async (ctx, id) => (await check({ home: ctx.home, env: ctx.env, cwd: ctx.cwd })).results.find((r) => r.id === id);
const staleNote = (r) => r.notes.find((n) => STALE.test(n));

for (const id of ['claude-code', 'codex']) {
  test('check: a fresh ' + id + ' install has no old-hooks note', async (t) => {
    const r = await result(install(t, id), id);
    assert.equal(r.state, 'protected');
    assert.equal(staleNote(r), undefined);
  });
}

test('check: Claude Code hooks written in the direct form are protected, with a note to install again', async (t) => {
  const ctx = install(t, 'claude-code');
  makeOld(ctx, 'claude-code');
  const r = await result(ctx, 'claude-code');
  assert.equal(r.state, 'protected');
  assert.match(staleNote(r), /run Node\.js directly instead of through zn's launcher script/);
  assert.match(staleNote(r), /`zn hooks install claude-code` again/);
  assert.doesNotMatch(staleNote(r), /lack/);
});

test('check: Codex hooks that lack current events are protected, with a note that names them', async (t) => {
  const ctx = install(t, 'codex');
  makeOld(ctx, 'codex', { direct: false, drop: ['PermissionRequest', 'SessionStart', 'SubagentStart', 'Stop'] });
  const r = await result(ctx, 'codex');
  assert.equal(r.state, 'protected');
  assert.match(staleNote(r), /lack these events the current install adds: PermissionRequest, SessionStart, SubagentStart, Stop; run `zn hooks install codex` again/);
});

test('check: Codex hooks in the direct form and without events give one note with both', { skip: process.platform === 'win32' }, async (t) => {
  const ctx = install(t, 'codex');
  makeOld(ctx, 'codex', { drop: ['PermissionRequest', 'Stop'] });
  const r = await result(ctx, 'codex');
  assert.equal(r.state, 'protected');
  const notes = r.notes.filter((n) => STALE.test(n));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /run Node\.js directly.*and they lack these events the current install adds: PermissionRequest, Stop/);
});

test('check: a hook written with a custom command is not flagged', async (t) => {
  const ctx = install(t, 'claude-code');
  const tree = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
  for (const groups of Object.values(tree.hooks)) for (const g of groups) for (const h of g.hooks) h.command = 'zn hook claude-code';
  fs.writeFileSync(ctx.file, JSON.stringify(tree));
  const r = await result(ctx, 'claude-code');
  assert.equal(staleNote(r), undefined);
});
