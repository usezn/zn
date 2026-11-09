'use strict';

// zn-gate check / doctor (without --hooks) end with one line on hook health, from the same listHooks as --hooks.
// Fictional agent configs in a temporary HOME; nothing outside it is read or written.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getAdapter } = require('../lib/agents');
const { listHooks, summaryLine } = require('../lib/hooks-list');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const SKIP = { skip: process.platform === 'win32' };

function setup(t, agents) {
  const home = tempDir(t, 'zn-hooks-sum-home-');
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH, ZN_STATS: 'off' };
  for (const id of agents) {
    getAdapter(id).install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  }
  return { home, env, cwd: tempDir(t, 'zn-hooks-sum-cwd-') };
}

const runCheck = (s, cmd) => spawnSync(process.execPath, [CLI, cmd], { cwd: s.cwd, env: s.env, encoding: 'utf8' });
const lines = (out) => out.split('\n').filter((l) => /^Hooks: /.test(l));

test('no hook installed: no summary line', (t) => {
  const s = setup(t, []);
  assert.equal(summaryLine(listHooks({ home: s.home, env: s.env, cwd: s.cwd })), '');
  assert.deepEqual(lines(runCheck(s, 'check').stdout), []);
});

test('all hooks OK: the line says 0 stale, 0 broken', SKIP, (t) => {
  const s = setup(t, ['codex']);
  const line = summaryLine(listHooks({ home: s.home, env: s.env, cwd: s.cwd }));
  assert.match(line, /^Hooks: \d+ OK, 0 stale, 0 broken\. Run zn-gate check --hooks for details\.$/);
  const out = lines(runCheck(s, 'check').stdout);
  assert.deepEqual(out, [line]);
});

test('one stale hook: the line says 1 stale, both for check and doctor, and uses the --hooks counts', SKIP, (t) => {
  const s = setup(t, ['codex']);
  const f = path.join(s.home, '.zn', 'hooks', 'zn-hook-codex.sh');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + '# an older launcher had other text here\n');
  // Keep a single hook event, so exactly one hook is listed.
  const cfg = path.join(s.home, '.codex', 'hooks.json');
  const data = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  const keep = Object.keys(data.hooks)[0];
  for (const k of Object.keys(data.hooks)) if (k !== keep) delete data.hooks[k];
  fs.writeFileSync(cfg, JSON.stringify(data));
  const res = listHooks({ home: s.home, env: s.env, cwd: s.cwd });
  assert.equal(res.counts.stale, 1);
  assert.equal(res.counts.broken, 0);
  for (const cmd of ['check', 'doctor']) {
    const out = lines(runCheck(s, cmd).stdout);
    assert.equal(out.length, 1);
    assert.match(out[0], /^Hooks: 0 OK, 1 stale, 0 broken\. /);
  }
});

