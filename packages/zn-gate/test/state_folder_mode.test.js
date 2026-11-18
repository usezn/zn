'use strict';
// zn's state folder: a loose folder owned by this account is tightened to 0700 (setgid and sticky dropped); a folder
// owned by someone else is refused, and the hook blocks instead of allowing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const posix = process.platform !== 'win32' && typeof process.getuid === 'function';
const skip = !posix && 'POSIX modes only';
const notRoot = posix && process.getuid() !== 0 ? false : 'needs a non-root account (a folder owned by another user)';
const FOREIGN = '/usr'; // owned by root

function tempHome() {
  const base = path.join(os.homedir(), 'tmpwork');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'zn-state-mode-'));
}
const modeOf = (p) => fs.statSync(p).mode & 0o7777;
function withEnv(env, fn) {
  const old = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; process.env[k] = env[k]; }
  const done = () => { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } };
  let r;
  try { r = fn(); } catch (e) { done(); throw e; }
  return r && typeof r.then === 'function' ? r.finally(done) : (done(), r);
}

test('ensureStateDir tightens an existing 0777 folder, a setgid one and a sticky one to 0700', { skip }, () => {
  const { ensureStateDir } = require('../lib/state-dir');
  const home = tempHome();
  try {
    for (const [name, mode] of [['a', 0o777], ['b', 0o2777], ['c', 0o1777]]) {
      const d = path.join(home, name);
      fs.mkdirSync(d); fs.chmodSync(d, mode);
      assert.strictEqual(modeOf(d), mode);
      ensureStateDir(d);
      assert.strictEqual(modeOf(d), 0o700);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a missing folder is created 0700 and a private one is left alone', { skip }, () => {
  const { ensureStateDir } = require('../lib/state-dir');
  const home = tempHome();
  try {
    const d = path.join(home, 'x', 'y');
    ensureStateDir(d);
    assert.strictEqual(modeOf(d), 0o700);
    ensureStateDir(d);
    assert.strictEqual(modeOf(d), 0o700);
    ensureStateDir(path.join(home, 'nope'), { create: false });
    assert.ok(!fs.existsSync(path.join(home, 'nope')));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a private subfolder of a loose state folder tightens the state folder too', { skip }, () => {
  const home = tempHome();
  const zn = path.join(home, '.zn');
  try {
    fs.mkdirSync(zn); fs.chmodSync(zn, 0o777);
    withEnv({ ZN_HOME: zn }, () => require('../lib/state-dir').ensureStateDir(path.join(zn, 'pins')));
    assert.strictEqual(modeOf(zn), 0o700);
    assert.strictEqual(modeOf(path.join(zn, 'pins')), 0o700);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a folder owned by another user is refused with a clear message', { skip: skip || notRoot }, () => {
  const { ensureStateDir } = require('../lib/state-dir');
  const before = modeOf(FOREIGN);
  assert.throws(() => ensureStateDir(FOREIGN), (e) => e.code === 'ZN_STATE_DIR' && /owned by another user/.test(e.message) && /will not use it/.test(e.message));
  assert.strictEqual(modeOf(FOREIGN), before);
});

test('stats save and the hook leave a 0777 or setgid state folder at 0700', { skip }, async () => {
  const home = tempHome();
  const zn = path.join(home, '.zn');
  try {
    fs.mkdirSync(zn); fs.chmodSync(zn, 0o777);
    await withEnv({ ZN_HOME: zn }, async () => {
      const stats = require('../lib/stats');
      stats.record({ layer: 'hook', agent: 'claude-code', checked: 1 });
      assert.strictEqual(modeOf(zn), 0o700);
      fs.chmodSync(zn, 0o2777);
      const runner = require('../lib/hooks/runner');
      const adapter = { id: 'claude-code', normalize: () => ({ event: 'session_start', cwd: home }), respond: (d) => d };
      const r = await runner.handle(adapter, {}, {});
      assert.notStrictEqual(r.decision.decision, 'deny');
      assert.strictEqual(modeOf(zn), 0o700);
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the hook blocks (fails closed) when the state folder belongs to someone else', { skip: skip || notRoot }, async () => {
  await withEnv({ ZN_HOME: FOREIGN }, async () => {
    const runner = require('../lib/hooks/runner');
    const ev = { event: 'pre_tool', tool: 'bash', toolName: 'Bash', input: { command: 'ls' } };
    const adapter = { id: 'claude-code', normalize: () => Object.assign({ cwd: process.cwd() }, ev), respond: (d) => d };
    const r = await runner.handle(adapter, {}, {});
    assert.strictEqual(r.decision.decision, 'deny');
    assert.strictEqual(r.decision.failClosed, true);
    assert.match(r.decision.message, /state folder .* owned by another user/);
  });
});

test('check reports the folder mode of a loose state folder', { skip }, async () => {
  const home = tempHome();
  const zn = path.join(home, '.zn');
  try {
    fs.mkdirSync(zn); fs.chmodSync(zn, 0o777);
    const { check } = require('../lib/check');
    const r = await check({ home, env: { ZN_HOME: zn, PATH: process.env.PATH }, cwd: home, live: false, nodeVersion: process.versions.node, hookNode: null });
    assert.ok(r.warnings.some((w) => /state folder .*mode 0777/.test(w)), JSON.stringify(r.warnings));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the vault layout tightens a setgid 2700 folder as well', { skip }, () => {
  const home = tempHome();
  const zn = path.join(home, '.zn');
  try {
    fs.mkdirSync(zn); fs.chmodSync(zn, 0o2700);
    const store = require('../lib/vault/store');
    store.ensureLayout({ home: zn });
    assert.strictEqual(modeOf(zn), 0o700);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
