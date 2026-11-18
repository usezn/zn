'use strict';
// Programs zn starts on its own (vault daemon, keychain and dialog helpers, browser opener, clipboard and process
// tools) never receive the caller's loader or interpreter start-up variables. Spawns are stubbed except the daemon,
// which is real: a NODE_OPTIONS --require file would run in it if the variable got through. All values are fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { safeEnv, LOADER_VAR } = require('../lib/safe-env');

const BAD = {
  NODE_OPTIONS: '--require /nonexistent/fake.js',
  NODE_PATH: '/nonexistent/fake',
  LD_PRELOAD: '/nonexistent/fake.so',
  LD_LIBRARY_PATH: '/nonexistent/fake',
  DYLD_INSERT_LIBRARIES: '/nonexistent/fake.dylib',
  GCONV_PATH: '/nonexistent/fake',
  PYTHONPATH: '/nonexistent/fake',
  BASH_ENV: '/nonexistent/fake.sh',
};
const KEEP = { PATH: '/usr/bin', HOME: '/home/example', NODE_EXTRA_CA_CERTS: '/nonexistent/ca.pem', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus' };

function withEnv(t, vars) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  t.after(() => { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
}

function stubCp(t, names) {
  const saved = {};
  const calls = [];
  for (const n of names) {
    saved[n] = cp[n];
    cp[n] = (...args) => {
      const opts = args.find((a) => a && typeof a === 'object' && !Array.isArray(a) && ('env' in a || 'encoding' in a || 'stdio' in a)) || {};
      calls.push({ file: args[0], env: opts.env });
      if (n === 'spawn') { const c = new EventEmitter(); c.kill = () => {}; setImmediate(() => c.emit('close', 1)); return c; }
      return { status: 1, stdout: '', stderr: '', error: null };
    };
  }
  t.after(() => { for (const n of names) cp[n] = saved[n]; });
  return calls;
}

function fresh(t, rels) {
  const keys = rels.map((r) => require.resolve(r));
  const drop = () => { for (const k of keys) delete require.cache[k]; };
  drop();
  t.after(drop);
  return rels.map((r) => require(r));
}

function assertClean(env, what) {
  assert.ok(env && typeof env === 'object', what + ': the spawn got an explicit env');
  for (const k of Object.keys(BAD)) assert.equal(k in env, false, what + ': ' + k + ' reached the child');
  assert.equal(env.NODE_EXTRA_CA_CERTS, KEEP.NODE_EXTRA_CA_CERTS, what + ': ordinary variables are kept');
}

test('safeEnv: drops loader variables in any case, keeps the rest, extra is added unfiltered', () => {
  const out = safeEnv(Object.assign({ node_options: '--require x', Ld_Preload: 'x' }, BAD, KEEP), { ZN_HOME: '/h' });
  for (const k of Object.keys(out)) assert.equal(LOADER_VAR.test(k), false, k);
  assert.deepEqual(Object.keys(out).sort(), Object.keys(KEEP).concat('ZN_HOME').sort());
  assert.equal(out.ZN_HOME, '/h');
});

test('keychain helper (security / secret-tool) gets no loader variables', (t) => {
  withEnv(t, Object.assign({ ZN_KEYCHAIN_BACKEND: 'macos' }, BAD, KEEP));
  const calls = stubCp(t, ['spawnSync']);
  const [keychain] = fresh(t, ['../lib/vault/keychain']);
  for (const b of ['macos', 'libsecret']) { try { keychain._native[b].load(); } catch (_) { /* the stub answers status 1 */ } }
  assert.ok(calls.length >= 1);
  for (const c of calls) assertClean(c.env, 'keychain ' + c.file);
});

test('confirm dialog (zenity, kdialog) gets no loader variables', async (t) => {
  const confirm = require('../lib/vault/confirm');
  const seen = [];
  const spawn = (file, args, options) => {
    seen.push(options.env);
    const c = new EventEmitter();
    c.kill = () => {};
    setImmediate(() => c.emit('close', 1));
    return c;
  };
  for (const tool of ['/usr/bin/zenity', '/usr/bin/kdialog']) {
    const ch = confirm.guiChannel({ spawn, platform: 'linux', env: Object.assign({ DISPLAY: ':0' }, BAD, KEEP), exists: (p) => p === tool });
    assert.equal(await ch.confirm({ title: 't', message: 'm' }), false);
  }
  assert.equal(seen.length, 2);
  for (const env of seen) { assertClean(env, 'dialog'); assert.equal(env.DISPLAY, ':0'); }
});

test('browser opener (xdg-open, open) gets no loader variables', (t) => {
  if (process.platform === 'win32') return; // Windows goes through psEnv, covered below
  withEnv(t, Object.assign({}, BAD, KEEP));
  const calls = stubCp(t, ['spawnSync']);
  const real = fs.statSync;
  t.after(() => { fs.statSync = real; });
  fs.statSync = (p, ...rest) => (String(p).endsWith('xdg-open') ? { isFile: () => true } : real(p, ...rest));
  const connect = require('../lib/connect-cli');
  connect.openBrowser('https://example.com/');
  assert.equal(calls.length, 1);
  assertClean(calls[0].env, 'opener');
});

test('clipboard and process-table tools get no loader variables', (t) => {
  if (process.platform === 'win32') return;
  withEnv(t, Object.assign({}, BAD, KEEP));
  const calls = stubCp(t, ['spawnSync']);
  const real = fs.existsSync;
  t.after(() => { fs.existsSync = real; });
  fs.existsSync = (p) => (/\/ps$/.test(String(p)) ? true : real(p));
  const [tty, ancestry] = fresh(t, ['../lib/broker/tty', '../lib/broker/ancestry']);
  try { tty.readClipboard({ timeoutMs: 50 }); } catch (_) { /* no tool answers */ }
  try { ancestry.agentAncestor({ pid: process.pid, platform: 'linux' }); } catch (_) { /* stub output */ }
  assert.ok(calls.length >= 1);
  for (const c of calls) assertClean(c.env, 'tool ' + c.file);
});

test('psEnv drops loader variables and still sets PSModulePath', () => {
  const exe = require('../lib/exe');
  const env = exe.psEnv('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', Object.assign({}, BAD, KEEP), { ZN_X: '1' });
  for (const k of Object.keys(BAD)) assert.equal(k in env, false, k);
  assert.equal(env.ZN_X, '1');
  assert.ok(env.PSModulePath);
});

test('vault daemon started by unlock does not load a NODE_OPTIONS --require file', async (t) => {
  if (process.platform === 'win32') return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-safeenv-'));
  const marker = path.join(home, 'marker');
  const preload = path.join(home, 'preload.js');
  fs.writeFileSync(preload, "require('fs').appendFileSync(" + JSON.stringify(marker) + ", String(process.pid) + '\\n');\n");
  // Control: the preload works for a process that does receive the variable.
  cp.spawnSync(process.execPath, ['-e', '0'], { env: Object.assign({}, process.env, { NODE_OPTIONS: '--require ' + preload }) });
  assert.ok(fs.existsSync(marker), 'the preload file runs when the variable reaches a node process');
  fs.rmSync(marker);
  withEnv(t, { HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn'), ZN_KEYCHAIN_BACKEND: 'passphrase', NODE_OPTIONS: '--require ' + preload, LD_PRELOAD: '' });
  delete process.env.LD_PRELOAD;
  const daemon = require('../lib/vault/daemon');
  let pid = 0;
  t.after(async () => {
    try { await daemon.lock({}); } catch (_) { /* already locked */ }
    for (let i = 0; i < 100 && pid; i++) { try { process.kill(pid, 0); } catch (_) { break; } await new Promise((r) => setTimeout(r, 100)); }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const u = await daemon.unlock({ passphrase: 'a pass phrase for the safe env test', workFactor: 10 });
  pid = u.pid;
  assert.equal(fs.existsSync(marker), false, 'the daemon must not run the preload file');
});
