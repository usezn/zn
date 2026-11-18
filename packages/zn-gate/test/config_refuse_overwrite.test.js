'use strict';
// connect (saveKey) and `stats share on|off` never replace a ~/.zn/config.json they cannot read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cloudKey = require('../lib/cloud-key');
const statsCli = require('../lib/stats-cli');

const FAKE_KEY = 'zn_example_key_0123456789abcdef';
const SETTINGS = { hooks: { strict: true }, extra: 'keep me' };

async function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-refuse-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ZN_HOME: process.env.ZN_HOME };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ZN_HOME;
  try {
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    await fn(path.join(home, '.zn', 'config.json'));
  } finally {
    cloudKey._use(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function fakeKeychain() {
  const calls = { store: 0 };
  let value = null;
  return {
    calls,
    native: { name: 'fake', slot: 'slot', impl: { store: (k) => { calls.store++; value = k; }, load: () => value, remove: () => { value = null; } } },
    vault: { isUnlocked: async () => false },
  };
}

const json = JSON.stringify(SETTINGS, null, 2);
const utf16le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(json, 'utf16le')]);
const bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(json)]);
const unreadable = {
  'broken JSON': Buffer.from('{"hooks": {"strict": true'),
  'comments': Buffer.from('{ // mine\n "hooks": {"strict": true} }'),
  'trailing comma': Buffer.from('{"hooks": {"strict": true},}'),
  'empty': Buffer.from(''),
  'not an object': Buffer.from('[1, 2]'),
};

function isPlainUtf8(file) {
  const b = fs.readFileSync(file);
  return !(b[0] === 0xEF || b[0] === 0xFF || b[0] === 0xFE) && b[0] === 0x7B;
}

// ---- connect (saveKey) ----

test('connect: a missing file is created', async () => {
  await withTempHome(async (file) => {
    cloudKey._use(fakeKeychain());
    await cloudKey.saveKey(FAKE_KEY);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cloud.store, 'keychain');
  });
});

for (const [name, buf] of [['UTF-8 BOM', bom], ['UTF-16', utf16le]]) {
  test(`connect: a ${name} file is read, kept and rewritten as plain UTF-8 with its settings`, async () => {
    await withTempHome(async (file) => {
      fs.writeFileSync(file, buf);
      cloudKey._use(fakeKeychain());
      await cloudKey.saveKey(FAKE_KEY);
      assert.ok(isPlainUtf8(file));
      const now = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(now.hooks, SETTINGS.hooks);
      assert.equal(now.extra, 'keep me');
      assert.equal(now.cloud.store, 'keychain');
    });
  });
}

for (const [name, buf] of Object.entries(unreadable)) {
  test(`connect: ${name} is refused, the file bytes stay and no key is stored`, async () => {
    await withTempHome(async (file) => {
      fs.writeFileSync(file, buf);
      const kc = fakeKeychain();
      cloudKey._use(kc);
      await assert.rejects(() => cloudKey.saveKey(FAKE_KEY), (e) => e.code === 'ZN_CONFIG_UNREADABLE' && /could not be read/.test(e.message) && /Fix or remove it/.test(e.message));
      assert.equal(kc.calls.store, 0);
      assert.deepEqual(fs.readFileSync(file), buf);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json']);
    });
  });
}

// ---- stats share ----

async function run(args) {
  let text = '';
  const code = await statsCli.run(args, (s) => { text += s; }, { confirm: async () => true });
  return { code, text };
}

test('stats share on: a missing file is created', async () => {
  await withTempHome(async (file) => {
    const r = await run(['share', 'on']);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stats.share, true);
  });
});

for (const [name, buf] of [['UTF-8 BOM', bom], ['UTF-16', utf16le]]) {
  for (const sub of ['on', 'off']) {
    test(`stats share ${sub}: a ${name} file keeps its settings and is rewritten as plain UTF-8`, async () => {
      await withTempHome(async (file) => {
        fs.writeFileSync(file, buf);
        const r = await run(['share', sub]);
        assert.equal(r.code, 0);
        assert.ok(isPlainUtf8(file));
        const now = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.deepEqual(now.hooks, SETTINGS.hooks);
        assert.equal(now.extra, 'keep me');
        assert.equal(now.stats.share, sub === 'on');
      });
    });
  }
}

for (const [name, buf] of Object.entries(unreadable)) {
  for (const sub of ['on', 'off']) {
    test(`stats share ${sub}: ${name} is refused with a message and the file bytes stay`, async () => {
      await withTempHome(async (file) => {
        fs.writeFileSync(file, buf);
        const r = await run(['share', sub]);
        assert.equal(r.code, 1);
        assert.match(r.text, /config\.json could not be read/);
        assert.match(r.text, /Fix or remove it, then run the command again/);
        assert.deepEqual(fs.readFileSync(file), buf);
        assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json']);
      });
    });
  }
}
