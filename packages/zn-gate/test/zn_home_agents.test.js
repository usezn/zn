'use strict';
/* ZN_HOME moves zn's own folder: patches and file writes into it are refused like writes into ~/.zn. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const policy = require('../lib/hooks/policy');
const runner = require('../lib/hooks/runner');
const { getAdapter } = require('../lib/agents');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const codex = getAdapter('codex');
const zcode = getAdapter('zcode');

// Sets ZN_HOME for fn (sync or async) and restores it after fn has finished.
function withZnHome(value, fn) {
  const prev = process.env.ZN_HOME;
  const restore = () => {
    if (prev === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = prev;
  };
  if (value === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = value;
  let result;
  try { result = fn(); } catch (err) { restore(); throw err; }
  return Promise.resolve(result).finally(restore);
}

function setup(t) {
  const home = tempDir(t, 'zn-home-agents-');
  const proj = path.join(home, 'proj');
  const zhome = path.join(home, 'elsewhere', 'zn-state');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(zhome, { recursive: true });
  return { home, proj, zhome };
}

function handle(adapter, raw, home) {
  return runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'zn run --', home });
}

const codexPatch = (proj, patch) => ({ session_id: 's', transcript_path: '/t', cwd: proj, hook_event_name: 'PreToolUse', model: 'm', tool_name: 'apply_patch', tool_input: { command: patch } });
const zcodePatch = (proj, patch) => ({ session_id: 's', hook_event_name: 'PreToolUse', cwd: proj, tool_name: 'ApplyPatch', tool_input: { patch_text: patch } });
const addFile = (file) => '*** Begin Patch\n*** Add File: ' + file + '\n+x\n*** End Patch';

test('policy: with ZN_HOME set elsewhere, the ZN_HOME folder is protected for writes and reads', (t) => {
  const { home, proj, zhome } = setup(t);
  const opts = { home, cwd: proj, env: { ZN_HOME: zhome } };
  assert.ok(policy.writeDenial(path.join(zhome, 'config.json'), opts), 'write into ZN_HOME');
  assert.ok(policy.writeDenial(path.join(zhome, 'sub', 'x.json'), opts), 'write below ZN_HOME');
  assert.ok(policy.readDenial(path.join(zhome, 'config.json'), opts), 'read of ZN_HOME');
  assert.equal(policy.writeDenial(path.join(home, 'elsewhere', 'other.json'), opts), null, 'a sibling folder stays free');
  assert.ok(policy.writeDenial(path.join(home, '.zn', 'config.json'), opts), '~/.zn stays protected too');
});

test('policy: without ZN_HOME nothing changes for other folders', (t) => {
  const { home, proj, zhome } = setup(t);
  assert.equal(policy.writeDenial(path.join(zhome, 'config.json'), { home, cwd: proj, env: {} }), null);
  assert.ok(policy.writeDenial(path.join(home, '.zn', 'config.json'), { home, cwd: proj, env: {} }));
});

test('policy: a ZN_HOME that is the home folder does not protect the whole home folder', (t) => {
  const { home, proj } = setup(t);
  assert.equal(policy.writeDenial(path.join(home, 'notes.txt'), { home, cwd: proj, env: { ZN_HOME: home } }), null);
});

test('policy: a short ZN_HOME such as /zn is protected; only a file system root is not taken', { skip: process.platform === 'win32' }, (t) => {
  const { home, proj } = setup(t);
  const opts = { home, cwd: proj, env: { ZN_HOME: '/zn' } };
  assert.ok(policy.writeDenial('/zn/config.json', opts), 'write into a short ZN_HOME');
  assert.ok(policy.writeDenial('/zn', opts), 'the short ZN_HOME folder itself');
  assert.ok(policy.readDenial('/zn/config.json', opts), 'read of a short ZN_HOME');
  assert.ok(policy.bashDenial('echo x > /zn/config.json', opts), 'shell redirect into a short ZN_HOME');
  assert.equal(policy.writeDenial('/znx/config.json', opts), null, 'a folder that only starts the same stays free');
  for (const root of ['/', '//']) {
    assert.equal(policy.writeDenial(path.join(proj, 'a.txt'), { home, cwd: proj, env: { ZN_HOME: root } }), null, root);
  }
});

test('policy: a short Windows ZN_HOME such as C:/zn is protected; a drive root is not taken', { skip: process.platform !== 'win32' }, (t) => {
  const { home, proj } = setup(t);
  const drive = path.parse(proj).root;
  const zh = drive + 'zn';
  const opts = { home, cwd: proj, env: { ZN_HOME: zh } };
  assert.ok(policy.writeDenial(path.join(zh, 'config.json'), opts), 'write into a short ZN_HOME');
  assert.ok(policy.writeDenial(zh.toLowerCase() + '/config.json', opts), 'another spelling of the same folder');
  assert.equal(policy.writeDenial(path.join(proj, 'a.txt'), { home, cwd: proj, env: { ZN_HOME: drive } }), null, 'drive root');
});

test('Codex: a patch that adds a file into ZN_HOME is refused, the same as one into ~/.zn', async (t) => {
  const { home, proj, zhome } = setup(t);
  await withZnHome(zhome, async () => {
    const res = await handle(codex, codexPatch(proj, addFile(path.join(zhome, 'config.json'))), home);
    assert.equal(res.decision.decision, 'deny');
    const home2 = await handle(codex, codexPatch(proj, addFile(path.join(home, '.zn', 'config.json'))), home);
    assert.equal(home2.decision.decision, 'deny');
    const ok = await handle(codex, codexPatch(proj, addFile(path.join(proj, 'src', 'a.js'))), home);
    assert.notEqual(ok.decision.decision, 'deny');
  });
});

test('Codex: without ZN_HOME a patch into a folder named like ZN_HOME is not refused', async (t) => {
  const { home, proj, zhome } = setup(t);
  await withZnHome(undefined, async () => {
    const res = await handle(codex, codexPatch(proj, addFile(path.join(zhome, 'config.json'))), home);
    assert.notEqual(res.decision.decision, 'deny');
    const real = await handle(codex, codexPatch(proj, addFile(path.join(home, '.zn', 'config.json'))), home);
    assert.equal(real.decision.decision, 'deny');
  });
});

test('ZCode: a patch that adds a file into ZN_HOME is refused, the same as one into ~/.zn', async (t) => {
  const { home, proj, zhome } = setup(t);
  await withZnHome(zhome, async () => {
    const res = await handle(zcode, zcodePatch(proj, addFile(path.join(zhome, 'config.json'))), home);
    assert.equal(res.decision.decision, 'deny');
    const real = await handle(zcode, zcodePatch(proj, addFile(path.join(home, '.zn', 'config.json'))), home);
    assert.equal(real.decision.decision, 'deny');
  });
});

test('znStateFile picks the first file in ~/.zn or ZN_HOME, and none otherwise', (t) => {
  const { home, proj, zhome } = setup(t);
  const { znStateFile } = require('../lib/agents/codex');
  withZnHome(zhome, () => {
    assert.equal(znStateFile(['src/a.js', path.join(zhome, 'c.json')], proj, home), path.join(zhome, 'c.json'));
    assert.equal(znStateFile(['src/a.js', path.join(home, '.zn', 'c.json')], proj, home), path.join(home, '.zn', 'c.json'));
    assert.equal(znStateFile(['src/a.js'], proj, home), undefined);
  });
  withZnHome(undefined, () => {
    assert.equal(znStateFile([path.join(zhome, 'c.json')], proj, home), undefined);
  });
});

test('policy: the deny message names the folder zn really uses', { skip: process.platform === 'win32' }, (t) => {
  const { home, proj } = setup(t);
  const plain = policy.writeDenial(path.join(home, '.zn', 'config.json'), { home, cwd: proj, env: {} });
  assert.match(plain, /^zn blocked this: ~\/\.zn is where zn keeps your secrets/);
  const moved = policy.writeDenial('/zn/config.json', { home, cwd: proj, env: { ZN_HOME: '/zn' } });
  assert.match(moved, /^zn blocked this: \/zn \(set by ZN_HOME; ~\/\.zn is protected too\) is where zn keeps your secrets/);
  const inHome = policy.bashDenial('echo x > ' + path.join(home, 'state', 'config.json'), { home, cwd: proj, env: { ZN_HOME: path.join(home, 'state') } });
  assert.match(inHome, /^zn blocked this: ~\/state \(set by ZN_HOME/);
  const wide = policy.writeDenial(path.join(home, '.zn', 'config.json'), { home, cwd: proj, env: { ZN_HOME: home } });
  assert.match(wide, /^zn blocked this: ~\/\.zn is where/);
  assert.match(policy.readDenial('/zn/vault.age', { home, cwd: proj, env: { ZN_HOME: '/zn' } }), /\/zn \(set by ZN_HOME/);
});
