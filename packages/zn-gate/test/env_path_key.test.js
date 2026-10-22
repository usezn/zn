'use strict';

// PATH read from an env object. Windows keeps the key as the caller wrote it
// ("Path" in a copied environment), so every read must ignore the key case.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const exe = require('../lib/exe');
const { detect: detectGemini } = require('../lib/agents/gemini');

test('envPath reads PATH whatever the key case', () => {
  assert.equal(exe.envPath({ Path: 'x' }), 'x');
  assert.equal(exe.envPath({ PATH: 'y' }), 'y');
  assert.equal(exe.envPath({ path: 'z' }), 'z');
  assert.equal(exe.envPath({}), '');
});

test('envPathKey names the key the env object already uses', () => {
  assert.equal(exe.envPathKey({ Path: 'x' }), 'Path');
  assert.equal(exe.envPathKey({ path: 'z' }), 'path');
  assert.equal(exe.envPathKey({}), 'PATH');
  assert.equal(exe.envPathKey({ PATH: 'y', Path: 'x' }), 'PATH');
});

test('an agent finds its CLI when the env object only has Path', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-envpath-bin-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-envpath-home-')));
  try {
    const win = process.platform === 'win32';
    fs.writeFileSync(path.join(dir, win ? 'gemini.cmd' : 'gemini'), win ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal(detectGemini({ env: { Path: dir }, home }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
