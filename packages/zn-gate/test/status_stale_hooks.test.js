'use strict';

// zn-gate status: one warning when an installed hook was written by an older zn-gate; quiet when all are current.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getAdapter } = require('../lib/agents');
const { staleWarning } = require('../lib/hooks-list');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const skip = { skip: process.platform === 'win32' };

function setup(t, agents) {
  const home = tempDir(t, 'zn-stale-home-');
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH };
  for (const id of agents) {
    getAdapter(id).install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  }
  return { home, env, cwd: tempDir(t, 'zn-stale-cwd-') };
}
const age = (home, id) => {
  const f = path.join(home, '.zn', 'hooks', 'zn-hook-' + id + '.sh');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^ZN_FILES=.*\n/m, ''));
};

test('current hooks: no warning', skip, (t) => {
  const s = setup(t, ['codex', 'cursor']);
  assert.equal(staleWarning({ home: s.home, env: s.env, cwd: s.cwd }), '');
});

test('one stale agent: warning names it and the refresh command, not the current one', skip, (t) => {
  const s = setup(t, ['codex', 'cursor']);
  age(s.home, 'codex');
  const w = staleWarning({ home: s.home, env: s.env, cwd: s.cwd });
  assert.match(w, /older zn-gate/);
  assert.match(w, /Codex CLI \(user\): run `zn hooks install codex`/);
  assert.doesNotMatch(w, /cursor/i);
  assert.doesNotMatch(w, /--project/);
});

test('project hooks: the command carries --project', skip, (t) => {
  const s = setup(t, ['codex']);
  age(s.home, 'codex');
  // A project hooks file that points at the same older launcher (as a project install of an older zn-gate would).
  const user = path.join(s.home, '.codex', 'hooks.json');
  fs.mkdirSync(path.join(s.cwd, '.codex'), { recursive: true });
  fs.copyFileSync(user, path.join(s.cwd, '.codex', 'hooks.json'));
  const w = staleWarning({ home: s.home, env: s.env, cwd: s.cwd });
  assert.match(w, /Codex CLI \(project\): run `zn hooks install codex --project`/);
  assert.match(w, /Codex CLI \(user\): run `zn hooks install codex`/);
});

test('status prints the warning, stays read-only and exits 0', skip, (t) => {
  const s = setup(t, ['codex']);
  age(s.home, 'codex');
  const run = () => spawnSync(process.execPath, [CLI, 'status'], { cwd: s.cwd, env: { ...s.env, ZN_STATS: 'off' }, encoding: 'utf8' });
  const r = run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Hooks +: a hook was installed by an older zn-gate/);
  assert.match(r.stdout, /run `zn hooks install codex`/);
  const ok = setup(t, ['codex']);
  const q = spawnSync(process.execPath, [CLI, 'status'], { cwd: ok.cwd, env: { ...ok.env, ZN_STATS: 'off' }, encoding: 'utf8' });
  assert.equal(q.status, 0);
  assert.doesNotMatch(q.stdout, /older zn-gate/);
});
