'use strict';
// Server entries (a command with arguments, a command alone, a URL) and pin
// files that hold the same hashes in another order, seen through serverKey,
// label, check and the pin file names of lib/mcp-pins.js. Fake values only;
// files are made in temporary folders.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
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

const keyOf = (argv) => crypto.createHash('sha256').update(JSON.stringify(argv)).digest('hex').slice(0, 16);
const A = { name: 'alpha', description: 'First tool.' };
const B = { name: 'beta', description: 'Second tool.' };

test('a command with arguments: flags and missing paths stay, an existing file is made absolute', (t) => {
  const dir = tempDir(t, 'zn-pins-helpers-');
  const script = path.join(dir, 'server.js');
  fs.writeFileSync(script, '// fake server\n');
  const prev = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(prev));
  assert.strictEqual(
    pins.serverKey('node', ['server.js', '--port', '9000', 'missing.js']),
    keyOf(['node', script, '--port', '9000', 'missing.js'])
  );
  assert.strictEqual(pins.label('node', ['server.js', '--port', '9000']), 'node ' + script + ' --port 9000');
});

test('a command alone has the same key and label with no arguments, an empty list or null', () => {
  const key = keyOf(['example-server']);
  assert.strictEqual(pins.serverKey('example-server'), key);
  assert.strictEqual(pins.serverKey('example-server', []), key);
  assert.strictEqual(pins.serverKey('example-server', null), key);
  assert.strictEqual(pins.label('example-server'), 'example-server');
  assert.strictEqual(pins.label('/opt/example/bin/example-server', []), 'example-server');
});

test('a URL entry is kept as it is and is not mistaken for a file', () => {
  const url = 'https://mcp.example.com/sse';
  assert.strictEqual(pins.serverKey(url), keyOf([url]));
  assert.notStrictEqual(pins.serverKey(url), pins.serverKey('https://mcp.example.com/other'));
  assert.strictEqual(pins.label(url), 'sse');
});

test('pin files are named by server key, one per server, inside pinsDir', (t) => {
  const home = tempDir(t, 'zn-pins-helpers-');
  asHome(home, () => {
    pins.check('node', ['one'], [A], {});
    pins.check('https://mcp.example.com/sse', [], [A], {});
    const names = fs.readdirSync(pins.pinsDir()).sort();
    assert.deepStrictEqual(names, [pins.serverKey('node', ['one']), pins.serverKey('https://mcp.example.com/sse')].map((k) => k + '.json').sort());
    assert.strictEqual(pins.pinsDir(), path.join(home, '.zn', 'mcp-pins'));
    assert.deepStrictEqual(pins.list().map((s) => s.key).sort(), names.map((n) => n.slice(0, 16)));
  });
});

test('two pin files with the same hashes in another order give the same result', (t) => {
  const home = tempDir(t, 'zn-pins-helpers-');
  asHome(home, () => {
    const hashes = { alpha: pins.toolHash(A), beta: pins.toolHash(B) };
    const reversed = { beta: hashes.beta, alpha: hashes.alpha };
    fs.mkdirSync(pins.pinsDir(), { recursive: true });
    const one = pins.serverKey('node', ['one']);
    const two = pins.serverKey('node', ['two']);
    const base = { command: 'node', pinnedAt: '2026-01-01T00:00:00.000Z', pending: {} };
    fs.writeFileSync(path.join(pins.pinsDir(), one + '.json'), JSON.stringify({ ...base, tools: hashes }));
    fs.writeFileSync(path.join(pins.pinsDir(), two + '.json'), JSON.stringify({ ...base, tools: reversed }));

    const r1 = pins.check('node', ['one'], [A, B], {});
    const r2 = pins.check('node', ['two'], [B, A], {});
    assert.strictEqual(r1.first, false);
    assert.strictEqual(r2.first, false);
    assert.strictEqual(r1.flagged.size, 0);
    assert.strictEqual(r2.flagged.size, 0);
    assert.deepStrictEqual(Object.keys(pins.approvedTools('node', ['one'])).sort(), ['alpha', 'beta']);
    assert.deepStrictEqual(Object.keys(pins.approvedTools('node', ['two'])).sort(), ['alpha', 'beta']);
    assert.deepStrictEqual(pins.list().map((s) => [s.tools, s.pending.length]), [[2, 0], [2, 0]]);
  });
});

test('pinsMoved is true when ZN_HOME names another folder', (t) => {
  const home = tempDir(t, 'zn-pins-helpers-');
  const saved = process.env.ZN_HOME;
  process.env.ZN_HOME = path.join(home, 'elsewhere');
  t.after(() => { if (saved === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = saved; });
  assert.strictEqual(pins.pinsMoved(), true);
  assert.strictEqual(pins.pinsDir(), path.join(home, 'elsewhere', 'mcp-pins'));
});
