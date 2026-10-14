'use strict';

// zn init: where each agent's MCP settings are looked for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

function antigravity() {
  delete require.cache[require.resolve('../lib/init')];
  return require('../lib/init').getKnownEnvironments().find((e) => e.id === 'antigravity');
}

test('Antigravity: the IDE file by default', () => {
  withHome((home) => {
    assert.equal(antigravity().filePath, path.join(home, '.gemini', 'antigravity', 'mcp_config.json'));
  });
});

test('Antigravity: the shared config when it exists', () => {
  withHome((home) => {
    const shared = path.join(home, '.gemini', 'config', 'mcp_config.json');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, '{"mcpServers":{}}');
    assert.equal(antigravity().filePath, shared);
  });
});
