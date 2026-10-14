'use strict';

// zn init: where each agent's MCP settings are looked for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getKnownEnvironments } = require('../lib/init');

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try { return fn(home); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('Antigravity: both settings files are checked', () => {
  withHome((home) => {
    const envs = getKnownEnvironments();
    const ide = envs.find((e) => e.id === 'antigravity');
    const shared = envs.find((e) => e.id === 'antigravity-shared');
    assert.equal(ide.filePath, path.join(home, '.gemini', 'antigravity', 'mcp_config.json'));
    assert.equal(shared.filePath, path.join(home, '.gemini', 'config', 'mcp_config.json'));
  });
});
