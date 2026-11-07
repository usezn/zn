'use strict';

process.env.ZN_STATS = 'off';

// A hook call that never needs the vault must not load the vault client (the runner used to load it after every
// event only to close it), and a call that does use it must still end by itself with its answer unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { generateAll } = require('./fixtures/fake_secrets');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const GHP = generateAll(5151, { perType: 1, piiPerType: 1 }).secrets.find((s) => s.type === 'github_pat_classic').value;

// Preload that writes, at exit, whether the vault client module was loaded.
const PROBE = "process.on('exit', () => { const hit = Object.keys(require.cache).some((k) => /[\\/]vault[\\/]client\.js$/.test(k)); require('fs').writeFileSync(process.env.ZN_TEST_PROBE, hit ? 'loaded' : 'not loaded'); });";

function run(t, agent, event) {
  const dir = tempDir(t, 'zn-vault-lazy-');
  const home = path.join(dir, 'home');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(home);
  fs.mkdirSync(proj);
  const probe = path.join(dir, 'probe.txt');
  const preload = path.join(dir, 'probe.js');
  fs.writeFileSync(preload, PROBE);
  const env = { ...process.env, ZN_HOME: home, HOME: home, USERPROFILE: home, ZN_STATS: 'off', ZN_KEYCHAIN_BACKEND: 'passphrase', ZN_TEST_PROBE: probe };
  const r = spawnSync(process.execPath, ['-r', preload, RUNNER, agent], { input: JSON.stringify({ session_id: 's1', cwd: proj, tool_use_id: 't', ...event }), env, cwd: proj, encoding: 'utf8', timeout: 20000 });
  return { r, loaded: fs.readFileSync(probe, 'utf8') };
}

test('an ordinary allowed command does not load the vault client', (t) => {
  const { r, loaded } = run(t, 'claude-code', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(loaded, 'not loaded');
});

test('an ordinary file read does not load the vault client', (t) => {
  const { r, loaded } = run(t, 'claude-code', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/app.js' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(loaded, 'not loaded');
});

test('a call that redacts still loads the client, answers and ends by itself', (t) => {
  const out = 'token: ' + GHP + '\nok\n';
  const { r, loaded } = run(t, 'claude-code', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat notes.txt' }, tool_response: { stdout: out, stderr: '', interrupted: false, isImage: false } });
  assert.equal(r.status, 0);
  assert.equal(r.signal, null);
  assert.equal(loaded, 'loaded');
  assert.ok(!r.stdout.includes(GHP), 'the fake token must not come back');
});
