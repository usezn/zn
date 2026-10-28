'use strict';
// approvedTools: the tools of a server that may be called, from its saved pins.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshHome(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-pins-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run fn with this process's home folder set to home (the pins module reads it at each call). */
function asHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ZN_HOME: process.env.ZN_HOME, ZN_MCP_PINNING: process.env.ZN_MCP_PINNING };
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

const pinsDirOf = (home) => path.join(home, '.zn', 'mcp-pins');

test('approvedTools is null for a server with no saved pins', (t) => {
  const home = freshHome(t);
  const pins = require('../lib/mcp-pins');
  asHome(home, () => {
    assert.strictEqual(pins.approvedTools('node', ['unknown-server']), null);
  });
});

test('approvedTools is an empty map when the saved pins are corrupt', (t) => {
  const home = freshHome(t);
  const pins = require('../lib/mcp-pins');
  asHome(home, () => {
    pins.check('node', ['srv-corrupt'], [{ name: 'a', description: '1' }], {});
    fs.writeFileSync(path.join(pinsDirOf(home), pins.serverKey('node', ['srv-corrupt']) + '.json'), '{not json');
    const ok = pins.approvedTools('node', ['srv-corrupt']);
    assert.notStrictEqual(ok, null);
    assert.deepStrictEqual(Object.keys(ok), []);
  });
});

test('approvedTools holds only the tools that are not pending', (t) => {
  const home = freshHome(t);
  const pins = require('../lib/mcp-pins');
  asHome(home, () => {
    pins.check('node', ['srv-mixed'], [{ name: 'a', description: '1' }, { name: 'b', description: '2' }], {});
    assert.deepStrictEqual(Object.keys(pins.approvedTools('node', ['srv-mixed'])).sort(), ['a', 'b']);

    // A changed tool and a new tool become pending; the unchanged one stays approved.
    pins.check('node', ['srv-mixed'], [
      { name: 'a', description: '1' },
      { name: 'b', description: 'changed' },
      { name: 'c', description: '3' },
    ], {});
    const ok = pins.approvedTools('node', ['srv-mixed']);
    assert.deepStrictEqual(Object.keys(ok), ['a']);
    assert.strictEqual(ok.a, true);
    assert.strictEqual(ok.b, undefined);
    assert.strictEqual(ok.c, undefined);

    // Approving the changes makes every tool usable again.
    pins.approve(pins.serverKey('node', ['srv-mixed']));
    assert.deepStrictEqual(Object.keys(pins.approvedTools('node', ['srv-mixed'])).sort(), ['a', 'b', 'c']);
  });
});
