'use strict';

// A hook is a new process on every tool call, so what it loads is what it
// waits for. A plain PreToolUse needs neither the scrubber engine nor the
// vault client, and the compile cache stays inside a private directory.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG = path.resolve(__dirname, '..');
const RUNNER = path.join(PKG, 'lib', 'hooks', 'runner.js');
const cc = require('../lib/compile-cache');

const created = [];
after(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-lazy-'));
  created.push(d);
  return d;
}

// Runs the hook code in a child with the same module graph as the hook and
// lists the zn modules it loaded.
function loadedModules(event) {
  const home = tmp();
  const script = [
    "const r = require(" + JSON.stringify(RUNNER) + ");",
    "const a = require(" + JSON.stringify(path.join(PKG, 'lib', 'agents')) + ").getAdapter('claude-code');",
    "r.handle(a, " + JSON.stringify(event) + ").then((res) => {",
    "  console.log(JSON.stringify({ d: res.decision && res.decision.decision, mods: Object.keys(require.cache) }));",
    '});',
  ].join('\n');
  const res = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn') },
  });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout.trim().split('\n').pop());
  return { decision: out.d, mods: out.mods.map((m) => path.relative(PKG, m).split(path.sep).join('/')) };
}

test('a plain PreToolUse does not load the scrubber, the vault client or the team policy', () => {
  const { decision, mods } = loadedModules({
    session_id: 's', cwd: os.tmpdir(), hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'npm test' }, tool_use_id: 't',
  });
  assert.equal(decision, 'allow');
  for (const m of mods) {
    assert.ok(!/^lib\/(scrub|vault|team)\//.test(m), 'loaded too early: ' + m);
  }
});

test('a PostToolUse still loads the scrubber engine', () => {
  const { mods } = loadedModules({
    session_id: 's', cwd: os.tmpdir(), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't',
    tool_input: { command: 'ls' }, tool_response: { stdout: 'hello', stderr: '' },
  });
  assert.ok(mods.includes('lib/scrub/engine.js'));
});

// Run in a child: the test runner itself may already have a compile cache enabled.
function enableIn(home) {
  const code = 'const r = require(' + JSON.stringify(path.join(PKG, 'lib', 'compile-cache')) + ').enable(); console.log(JSON.stringify(r));';
  const env = { ...process.env, ZN_HOME: home };
  delete env.NODE_COMPILE_CACHE;
  const res = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim());
}

test('the compile cache lives under ZN_HOME, closed to other users', { skip: process.platform === 'win32' }, () => {
  const home = path.join(tmp(), 'zhome');
  fs.mkdirSync(home, { mode: 0o700 });
  const dir = enableIn(home);
  if (dir === null) return; // Node older than 22.1: no compile cache, nothing to check
  // Compared as real paths: on macOS the temporary folder is under /var, a link to /private/var.
  assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(home)), 'cache directory: ' + dir);
  for (const d of [home, path.join(home, 'cache'), path.join(home, 'cache', 'compile')]) {
    assert.equal(fs.statSync(d).mode & 0o077, 0, d + ' must be private');
  }
});

test('the compile cache is skipped when the directory is open to other users', { skip: process.platform === 'win32' }, () => {
  const home = path.join(tmp(), 'zhome');
  fs.mkdirSync(path.join(home, 'cache', 'compile'), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(home, 'cache', 'compile'), 0o777);
  assert.equal(cc.enable({ ZN_HOME: home }), null);
});

test('the compile cache is skipped when its directory is a link, or when turned off', { skip: process.platform === 'win32' }, () => {
  const base = tmp();
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(elsewhere, { mode: 0o700 });
  const home = path.join(base, 'zhome');
  fs.mkdirSync(path.join(home, 'cache'), { recursive: true, mode: 0o700 });
  fs.symlinkSync(elsewhere, path.join(home, 'cache', 'compile'));
  assert.equal(cc.enable({ ZN_HOME: home }), null);
  assert.equal(cc.enable({ ZN_HOME: path.join(base, 'other'), ZN_NO_COMPILE_CACHE: '1' }), null);
});

test('a hook gives the same answer with the compile cache on, off and warm', () => {
  const home = tmp();
  const ev = JSON.stringify({ session_id: 's', cwd: home, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat .env' }, tool_use_id: 't' });
  const run = (extra) => spawnSync(process.execPath, [RUNNER, 'claude-code'], {
    input: ev, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn'), ...extra },
  });
  const off = run({ ZN_NO_COMPILE_CACHE: '1' });
  const cold = run({});
  const warm = run({});
  assert.equal(cold.stdout, off.stdout);
  assert.equal(warm.stdout, off.stdout);
  assert.equal(warm.status, off.status);
});
