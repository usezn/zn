'use strict';
// Server entries whose program path or argument contains a space, seen through
// serverKey and label of lib/mcp-pins.js. Fake values only; the one file is made
// in a temporary folder.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const pins = require('../lib/mcp-pins');

test('a relative argument with a space resolves to the same server key as its absolute path', (t) => {
  const dir = tempDir(t, 'zn-pins-spaces-');
  const rel = path.join('example tools', 'server bin.js');
  fs.mkdirSync(path.join(dir, 'example tools'));
  fs.writeFileSync(path.join(dir, rel), '// fake server file\n');
  const saved = process.cwd();
  process.chdir(dir);
  try {
    assert.strictEqual(pins.serverKey('node', [rel]), pins.serverKey('node', [path.join(dir, rel)]));
  } finally {
    process.chdir(saved);
  }
});

test('a Windows program path with spaces is kept whole in the key and ends the label with the program name', () => {
  const exe = 'C:\\Program Files\\Example Tools\\server.exe';
  const key = pins.serverKey(exe, ['--stdio']);
  assert.match(key, /^[0-9a-f]{16}$/);
  // Splitting the path at its space gives a different server, so the key must differ.
  assert.notStrictEqual(key, pins.serverKey('C:\\Program', ['Files\\Example Tools\\server.exe', '--stdio']));
  assert.match(pins.label(exe, ['--stdio']), /server\.exe --stdio$/);
});

test('a POSIX program path with a space is labelled by its program name and arguments', () => {
  assert.strictEqual(pins.label('/opt/Example Tools/bin/server', ['--port', '8080']), 'server --port 8080');
});
