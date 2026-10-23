'use strict';
// The pin file of an MCP server: what is written in a temporary home folder,
// what a changed tool does to it, and what happens when there is no file.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const pins = require('../lib/mcp-pins');

/** Run fn with this process's home folder set to home (the pins module reads it at each call). */
function asHome(home, fn) {
  const names = ['HOME', 'USERPROFILE', 'ZN_HOME', 'ZN_MCP_PINNING'];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ZN_HOME;
  delete process.env.ZN_MCP_PINNING;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const pinFile = (home, key) => path.join(home, '.zn', 'mcp-pins', key + '.json');
const TOOL = { name: 'lookup', description: 'Look up a word.' };

test('the first list writes one pin file with hashes and no tool text', (t) => {
  const home = tempDir(t, 'zn-pins-files-');
  asHome(home, () => {
    const res = pins.check('node', ['srv-a'], [TOOL], {});
    assert.strictEqual(res.first, true);
    assert.strictEqual(res.flagged.size, 0);
    const key = pins.serverKey('node', ['srv-a']);
    const raw = fs.readFileSync(pinFile(home, key), 'utf8');
    const saved = JSON.parse(raw);
    assert.strictEqual(saved.tools.lookup, pins.toolHash(TOOL));
    assert.deepStrictEqual(saved.pending, {});
    assert.ok(!raw.includes('Look up a word.'));
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(pinFile(home, key)).mode & 0o777, 0o600);
    }
    assert.deepStrictEqual(fs.readdirSync(path.dirname(pinFile(home, key))), [key + '.json']);
  });
});

test('a changed tool is reported and its new hash is saved as pending', (t) => {
  const home = tempDir(t, 'zn-pins-files-');
  asHome(home, () => {
    pins.check('node', ['srv-b'], [TOOL], {});
    const changed = { ...TOOL, description: 'Look up a word and a phrase.' };
    const res = pins.check('node', ['srv-b'], [changed], {});
    assert.strictEqual(res.first, false);
    assert.deepStrictEqual([...res.flagged], ['lookup']);
    const saved = JSON.parse(fs.readFileSync(pinFile(home, pins.serverKey('node', ['srv-b'])), 'utf8'));
    assert.strictEqual(saved.tools.lookup, pins.toolHash(TOOL));
    assert.strictEqual(saved.pending.lookup.hash, pins.toolHash(changed));
    assert.deepStrictEqual(pins.list().map((s) => s.pending), [['lookup']]);
  });
});

test('an unchanged list on a later run is not reported', (t) => {
  const home = tempDir(t, 'zn-pins-files-');
  asHome(home, () => {
    pins.check('node', ['srv-c'], [TOOL], {});
    const res = pins.check('node', ['srv-c'], [{ ...TOOL }], {});
    assert.strictEqual(res.first, false);
    assert.strictEqual(res.flagged.size, 0);
  });
});

test('approve makes the changed hash the pinned one', (t) => {
  const home = tempDir(t, 'zn-pins-files-');
  asHome(home, () => {
    pins.check('node', ['srv-d'], [TOOL], {});
    const changed = { ...TOOL, description: 'Different text.' };
    pins.check('node', ['srv-d'], [changed], {});
    const key = pins.serverKey('node', ['srv-d']);
    assert.deepStrictEqual(pins.approve(key).approved.map((a) => a.tools), [['lookup']]);
    const saved = JSON.parse(fs.readFileSync(pinFile(home, key), 'utf8'));
    assert.strictEqual(saved.tools.lookup, pins.toolHash(changed));
    assert.deepStrictEqual(saved.pending, {});
    assert.strictEqual(pins.check('node', ['srv-d'], [changed], {}).flagged.size, 0);
  });
});

test('with no pin file: no pins are listed, approvedTools is null, approve reports the server is unknown', (t) => {
  const home = tempDir(t, 'zn-pins-files-');
  asHome(home, () => {
    assert.deepStrictEqual(pins.list(), []);
    assert.strictEqual(pins.approvedTools('node', ['srv-none']), null);
    assert.deepStrictEqual(pins.approve('0123456789abcdef').approved, []);
    assert.match(pins.approve('0123456789abcdef').error, /no server/);
    assert.deepStrictEqual(pins.approve('--all'), { approved: [] });
    assert.strictEqual(fs.existsSync(path.join(home, '.zn', 'mcp-pins')), false);
  });
});

test('a pin file that is removed after the first run pins the server again', (t) => {
  const home = tempDir(t, 'zn-pins-files-');
  asHome(home, () => {
    pins.check('node', ['srv-e'], [TOOL], {});
    fs.unlinkSync(pinFile(home, pins.serverKey('node', ['srv-e'])));
    const res = pins.check('node', ['srv-e'], [{ ...TOOL, description: 'New.' }], {});
    assert.strictEqual(res.first, true);
    assert.strictEqual(res.flagged.size, 0);
  });
});
