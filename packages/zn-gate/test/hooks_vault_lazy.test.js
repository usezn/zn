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
const PROBE = "process.on('exit', () => { const hit = Object.keys(require.cache).some((k) => /[\\\\/]vault[\\\\/]client\.js$/.test(k)); require('fs').writeFileSync(process.env.ZN_TEST_PROBE, hit ? 'loaded' : 'not loaded'); });";

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

test('the vault files every call checks are the files a require of the vault client loads', () => {
  const lib = path.join(__dirname, '..', 'lib');
  const code = "const p=require('path');const lib=process.argv[1];const b=new Set(Object.keys(require.cache));require(p.join(lib,'vault','client.js'));" +
    "process.stdout.write(JSON.stringify(Object.keys(require.cache).filter((k)=>!b.has(k)).map((k)=>p.relative(lib,k).split(p.sep).join('/')).sort()))";
  const r = spawnSync(process.execPath, ['-e', code, lib], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const { VAULT_CLIENT_FILES } = require('../lib/hooks/runner');
  assert.deepEqual([...VAULT_CLIENT_FILES].sort(), JSON.parse(r.stdout));
});

test('a call that redacts still loads the client, answers and ends by itself', (t) => {
  const out = 'token: ' + GHP + '\nok\n';
  const { r, loaded } = run(t, 'claude-code', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat notes.txt' }, tool_response: { stdout: out, stderr: '', interrupted: false, isImage: false } });
  assert.equal(r.status, 0);
  assert.equal(r.signal, null);
  assert.equal(loaded, 'loaded');
  assert.ok(!r.stdout.includes(GHP), 'the fake token must not come back');
});

test('the hook runner does not name the module built-in: the vault file check reads require.extensions', () => {
  const src = fs.readFileSync(RUNNER, 'utf8');
  assert.ok(!/require\s*\(\s*['"](?:node:)?module['"]\s*\)/.test(src));
  assert.ok(/require\.extensions\['\.js'\]/.test(src));
});

// The loader the check reads is the one a launcher replaces: a '.js' loader that refuses a vault file refuses it for the runner's check too.
test('the vault file check hands every vault file to the installed .js loader and a refusal stops the call', (t) => {
  const dir = tempDir(t, 'zn-vault-loader-');
  const log = path.join(dir, 'log.json');
  const preload = path.join(dir, 'hook.js');
  fs.writeFileSync(preload, [
    'const seen = [];',
    "const store = require('path').join('vault', 'store.js');",
    "const orig = require.extensions['.js'];",
    "require.extensions['.js'] = function (m, f) { seen.push(f); if (f.endsWith(store) && process.env.ZN_TEST_REFUSE) process.exit(97); return orig(m, f); };",
    "process.on('exit', () => require('fs').writeFileSync(process.env.ZN_TEST_LOG, JSON.stringify(seen)));",
  ].join('\n'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const base = { ...process.env, ZN_HOME: home, HOME: home, USERPROFILE: home, ZN_STATS: 'off', ZN_TEST_LOG: log };
  const ev = JSON.stringify({ session_id: 's1', cwd: dir, tool_use_id: 't', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const ok = spawnSync(process.execPath, ['-r', preload, RUNNER, 'claude-code'], { input: ev, env: base, cwd: dir, encoding: 'utf8', timeout: 20000 });
  assert.notEqual(ok.status, 97);
  const seen = JSON.parse(fs.readFileSync(log, 'utf8')).map((f) => f.split(path.sep).slice(-2).join('/'));
  for (const f of ['vault/client.js', 'vault/store.js', 'vault/winacl.js']) assert.ok(seen.includes(f), f + ' was handed to the loader: ' + seen.join(','));
  const refused = spawnSync(process.execPath, ['-r', preload, RUNNER, 'claude-code'], { input: ev, env: { ...base, ZN_TEST_REFUSE: '1' }, cwd: dir, encoding: 'utf8', timeout: 20000 });
  assert.equal(refused.status, 97, 'a loader that refuses a vault file ends the run before the event is handled');
  assert.equal(refused.stdout, '');
});
