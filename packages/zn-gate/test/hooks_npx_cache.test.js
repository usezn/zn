'use strict';

// `npx -y zn-gate hooks install <agent>` runs from npm's _npx cache. The hooks must not name a runner in that
// cache (npm can delete it at any time): zn keeps its own copy under ~/.zn/runtime/<version>/zn-gate.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getAdapter } = require('../lib/agents');
const { check: realCheck } = require('../lib/check');
const check = (opts) => realCheck({ nodeVersion: '22.0.0', ...opts });
const { tempDir } = require('./helpers/tmp');
const runtime = require('../lib/agents/runtime');

const PKG = path.join(__dirname, '..');

/* A copy of this package where npx would put it: <cache>/_npx/<hash>/node_modules/zn-gate. */
function fakeNpxCopy(t) {
  const cache = tempDir(t, 'zn-npx-cache-');
  const root = path.join(cache, '_npx', 'abc123', 'node_modules', 'zn-gate');
  fs.mkdirSync(root, { recursive: true });
  for (const n of ['bin', 'lib', 'package.json']) fs.cpSync(path.join(PKG, n), path.join(root, n), { recursive: true });
  return { cache, root, runner: path.join(root, 'lib', 'hooks', 'runner.js') };
}

const AGENTS = ['claude-code', 'codex', 'cursor', 'gemini', 'antigravity', 'opencode'];

function installFrom(t, id, npx) {
  const home = tempDir(t, 'zn-npx-home-');
  const env = { HOME: home, PATH: process.env.PATH };
  getAdapter(id).install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: npx.runner, mcp: false });
  return { home, env };
}

function filesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p)); else out.push(p);
  }
  return out;
}

test('npx cache: no agent writes the _npx path, and a stable copy exists', (t) => {
  const npx = fakeNpxCopy(t);
  for (const id of AGENTS) {
    const { home } = installFrom(t, id, npx);
    for (const f of filesUnder(home)) {
      if (f.includes(path.join('.zn', 'runtime'))) continue;
      assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /_npx/, id + ': ' + f + ' still names the npx cache');
    }
    const version = require('../package.json').version;
    const stable = path.join(home, '.zn', 'runtime', version, 'zn-gate', 'lib', 'hooks', 'runner.js');
    assert.ok(fs.existsSync(stable), id + ': no stable copy');
  }
});

test('npx cache: the hook still blocks after the cache is deleted', (t) => {
  const npx = fakeNpxCopy(t);
  const { home } = installFrom(t, 'claude-code', npx);
  fs.rmSync(npx.cache, { recursive: true, force: true });
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const launcherCmd = settings.hooks.PreToolUse[0].hooks[0].command;
  assert.match(launcherCmd, /zn-hook-claude-code\.sh' PreToolUse$/);
  const script = launcherCmd.replace(/^'([^']+)'.*$/, '$1');
  const body = fs.readFileSync(script, 'utf8');
  const runner = /^ZN_RUNNER='([^']+)'$/m.exec(body)[1];
  assert.ok(runner.startsWith(path.join(home, '.zn', 'runtime')), runner);
  assert.ok(fs.existsSync(runner));
  fs.mkdirSync(path.join(home, 'proj'), { recursive: true });
  fs.writeFileSync(path.join(home, 'proj', '.env'), 'API_KEY=sk-example-not-real-0000' + String.fromCharCode(10));
  fs.writeFileSync(path.join(home, 'proj', 'README.txt'), 'hello');
  // Run the launcher as Claude Code does: it must reach the kept copy, not fall back to blocking everything.
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'zn-test', tool_name: 'Read', tool_input: { file_path: path.join(home, 'proj', '.env') }, cwd: path.join(home, 'proj') });
  const run = (file) => spawnSync(script, ['PreToolUse'], { input: JSON.stringify(file), encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin', ZN_STATS: 'off' } });
  const secret = run(JSON.parse(input));
  assert.match(secret.stdout + secret.stderr, /deny|block|\.env/i, secret.stdout + secret.stderr);
  assert.doesNotMatch(secret.stderr, /cannot start because the Node\.js or the zn-gate files/);
  const plain = run({ hook_event_name: 'PreToolUse', session_id: 'zn-test', tool_name: 'Read', tool_input: { file_path: path.join(home, 'proj', 'README.txt') }, cwd: path.join(home, 'proj') });
  assert.equal(plain.status, 0);
  assert.doesNotMatch(plain.stdout + plain.stderr, /cannot start because/);
});

test('npx cache: a normal install is not copied', (t) => {
  const home = tempDir(t, 'zn-npx-home-');
  const runner = path.join(PKG, 'lib', 'hooks', 'runner.js');
  assert.equal(runtime.stableRunner(runner, { home, env: { HOME: home } }), runner);
  assert.ok(!fs.existsSync(path.join(home, '.zn', 'runtime')));
});

test('npx cache: an incomplete copy is replaced, a complete one reused', (t) => {
  const npx = fakeNpxCopy(t);
  const home = tempDir(t, 'zn-npx-home-');
  const opts = { home, env: { HOME: home } };
  const a = runtime.stableRunner(npx.runner, opts);
  fs.rmSync(path.join(path.dirname(a), '..', '..', '.zn-runtime-complete'));
  fs.rmSync(a);
  const b = runtime.stableRunner(npx.runner, opts);
  assert.equal(a, b);
  assert.ok(fs.existsSync(b));
});

test('check: a hook whose runner is in the npx cache is reported as fragile', async (t) => {
  const npx = fakeNpxCopy(t);
  const home = tempDir(t, 'zn-npx-home-');
  const env = { HOME: home, PATH: process.env.PATH };
  // A hook written by an older zn-gate: the plain command naming the cache path.
  const command = require('../lib/agents/claude-code').hookCommand({ nodePath: process.execPath, runnerPath: npx.runner });
  assert.match(command, /_npx/);
  getAdapter('claude-code').install({ scope: 'user', home, env, command, mcp: false });
  const res = await check({ home, env, cwd: tempDir(t, 'zn-npx-cwd-') });
  const r = (res.agents || res.results || res).find((x) => x.id === 'claude-code');
  assert.ok(r.notes.some((n) => /FRAGILE: .*npx cache.*npm install -g zn-gate.*zn hooks install claude-code/.test(n)), JSON.stringify(r.notes));
});
