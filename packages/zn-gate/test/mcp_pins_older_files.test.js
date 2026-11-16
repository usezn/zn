'use strict';
// Loading a pin file written by an older version: missing fields, unknown
// extra fields and an empty object must never throw.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const pins = require('../lib/mcp-pins');

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

const TOOL = { name: 'lookup', description: 'Look up a word.' };

/** Write an older-style pin file for a server and return its path. */
function writePins(home, args, content) {
  const file = path.join(home, '.zn', 'mcp-pins', pins.serverKey('node', args) + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

test('a file without the optional fields (no pinnedAt, command) is still read', (t) => {
  const home = tempDir(t, 'zn-pins-old-');
  asHome(home, () => {
    writePins(home, ['old-a'], { tools: { lookup: pins.toolHash(TOOL) }, pending: {} });
    const res = pins.check('node', ['old-a'], [TOOL], {});
    assert.strictEqual(res.first, false);
    assert.strictEqual(res.flagged.size, 0);
    assert.deepStrictEqual(Object.keys(pins.approvedTools('node', ['old-a'])), ['lookup']);
    const [entry] = pins.list();
    assert.strictEqual(entry.tools, 1);
    assert.strictEqual(entry.firstPinnedAt, null);
    assert.deepStrictEqual(pins.approve('--all').approved, []);
  });
});

test('unknown extra fields are kept when the file is saved again', (t) => {
  const home = tempDir(t, 'zn-pins-old-');
  asHome(home, () => {
    const file = writePins(home, ['old-b'], { version: 1, note: 'x', tools: { lookup: pins.toolHash(TOOL) }, pending: {} });
    const changed = { ...TOOL, description: 'Look up a word and a phrase.' };
    const res = pins.check('node', ['old-b'], [changed], {});
    assert.deepStrictEqual([...res.flagged], ['lookup']);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(saved.version, 1);
    assert.strictEqual(saved.note, 'x');
    assert.strictEqual(saved.pending.lookup.hash, pins.toolHash(changed));
  });
});

for (const [label, content] of [
  ['an empty object', {}],
  ['a file without pending', { tools: {} }],
  ['a file without tools', { pending: {} }],
  ['a file with null maps', { tools: null, pending: null }],
]) {
  test(label + ' is treated as unreadable: nothing throws and the bad file is kept aside', (t) => {
    const home = tempDir(t, 'zn-pins-old-');
    asHome(home, () => {
      const file = writePins(home, ['old-c'], content);
      assert.deepStrictEqual(pins.list().map((e) => e.command), ['(unreadable pins file)']);
      assert.deepStrictEqual(Object.keys(pins.approvedTools('node', ['old-c'])), []);
      assert.deepStrictEqual(pins.approve('--all').approved, []);
      const res = pins.check('node', ['old-c'], [TOOL], {});
      assert.strictEqual(res.first, false);
      assert.ok(res.flagged.has('lookup'));
      const names = fs.readdirSync(path.dirname(file));
      assert.ok(names.some((n) => n.includes('.corrupt-')), 'the bad file is kept aside');
    });
  });
}
